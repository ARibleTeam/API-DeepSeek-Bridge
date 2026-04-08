import asyncio
import concurrent.futures
import json
import threading
import uuid
from typing import Any, Dict, Optional

import websockets


def _extract_result_from_json(parsed_json: Any) -> Optional[str]:
    if not isinstance(parsed_json, dict):
        return None
    result = parsed_json.get("result")
    if isinstance(result, str) and result.strip():
        return result.strip()
    if parsed_json.get("command") == "final":
        args = parsed_json.get("args")
        if isinstance(args, dict):
            ar = args.get("result")
            if isinstance(ar, str) and ar.strip():
                return ar.strip()
    args = parsed_json.get("args")
    if isinstance(args, dict):
        ar = args.get("result")
        if isinstance(ar, str) and ar.strip():
            return ar.strip()
    return None


class DeepSeekBridge:
    def __init__(
        self,
        *,
        ws_host: str = "127.0.0.1",
        ws_port: int = 8765,
        request_timeout_seconds: float = 180.0,
        connect_timeout_seconds: float = 60.0,
        reuse_deepseek_tab: bool = False,
    ):
        self.ws_host = ws_host
        self.ws_port = ws_port
        self.request_timeout_seconds = request_timeout_seconds
        self.connect_timeout_seconds = connect_timeout_seconds
        self.reuse_deepseek_tab = reuse_deepseek_tab
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._server_started = threading.Event()
        self._extension_connected = threading.Event()
        self._state_lock = threading.Lock()
        self._active_ws: Optional[websockets.WebSocketServerProtocol] = None
        self._pending_results: Dict[str, concurrent.futures.Future] = {}
        self._start_background_server()

    def _start_background_server(self) -> None:
        with self._state_lock:
            if self._thread and self._thread.is_alive():
                return

            self._server_started.clear()
            self._extension_connected.clear()

            self._thread = threading.Thread(target=self._run_server_loop, daemon=True)
            self._thread.start()

        if not self._server_started.wait(timeout=5):
            raise RuntimeError("Failed to start DeepSeek bridge websocket server")

    def _run_server_loop(self) -> None:
        loop = asyncio.new_event_loop()
        self._loop = loop
        asyncio.set_event_loop(loop)
        loop.run_until_complete(self._serve_forever())

    async def _serve_forever(self) -> None:
        async def handler(ws: websockets.WebSocketServerProtocol):
            with self._state_lock:
                self._active_ws = ws
            self._extension_connected.set()
            try:
                async for raw in ws:
                    try:
                        msg = json.loads(raw)
                    except Exception:
                        continue

                    if msg.get("type") == "hello":
                        continue
                    if msg.get("type") == "ping":
                        try:
                            await ws.send(
                                json.dumps(
                                    {"type": "pong", "ts": msg.get("ts")},
                                    ensure_ascii=False,
                                )
                            )
                        except Exception:
                            pass
                        continue

                    if msg.get("type") not in ("deepseek_task_result", "deepseek_close_reuse_tab_result"):
                        continue

                    request_id = msg.get("requestId")
                    if not isinstance(request_id, str) or not request_id:
                        continue

                    with self._state_lock:
                        fut = self._pending_results.pop(request_id, None)
                    if fut and not fut.done():
                        fut.set_result(msg)
            finally:
                with self._state_lock:
                    if self._active_ws is ws:
                        self._active_ws = None
                self._extension_connected.clear()

        server = await websockets.serve(handler, self.ws_host, self.ws_port)
        self._server_started.set()
        await server.wait_closed()

    async def _send_task(self, request_id: str, payload: Dict[str, Any], timeout_ms: int) -> None:
        ws = self._active_ws
        if ws is None:
            raise RuntimeError("Extension is not connected")

        await ws.send(
            json.dumps(
                {
                    "type": "deepseek_task",
                    "requestId": request_id,
                    "payload": payload,
                    "timeoutMs": timeout_ms,
                },
                ensure_ascii=False,
            )
        )

    async def _send_close_reuse_tab(self, request_id: str) -> None:
        ws = self._active_ws
        if ws is None:
            raise RuntimeError("Extension is not connected")
        await ws.send(
            json.dumps(
                {"type": "deepseek_close_reuse_tab", "requestId": request_id},
                ensure_ascii=False,
            )
        )

    async def _request_async(self, payload: Dict[str, Any], timeout_ms: int) -> Dict[str, Any]:
        request_id = f"req-{uuid.uuid4()}"
        return await asyncio.to_thread(self._request_sync, payload, timeout_ms, request_id)

    def _request_sync(self, payload: Dict[str, Any], timeout_ms: int, request_id: Optional[str] = None) -> Dict[str, Any]:
        self._start_background_server()
        request_id = request_id or f"req-{uuid.uuid4()}"

        if not self._extension_connected.wait(timeout=self.connect_timeout_seconds):
            raise TimeoutError(
                f"Extension did not connect to ws://{self.ws_host}:{self.ws_port} within {self.connect_timeout_seconds}s"
            )

        loop = self._loop
        if loop is None:
            raise RuntimeError("Bridge event loop is not running")

        result_future: concurrent.futures.Future = concurrent.futures.Future()
        with self._state_lock:
            self._pending_results[request_id] = result_future

        try:
            send_future = asyncio.run_coroutine_threadsafe(
                self._send_task(request_id=request_id, payload=payload, timeout_ms=timeout_ms),
                loop,
            )
            send_future.result(timeout=3)
        except Exception as e:
            with self._state_lock:
                self._pending_results.pop(request_id, None)
            raise RuntimeError(f"Failed to send task to extension: {e}") from e

        try:
            response = result_future.result(timeout=timeout_ms / 1000 + 5)
        except concurrent.futures.TimeoutError as e:
            with self._state_lock:
                self._pending_results.pop(request_id, None)
            raise TimeoutError("Extension task timed out") from e

        if not isinstance(response, dict):
            raise RuntimeError("Invalid response from extension")
        return response

    def _close_reuse_tab_sync(self, timeout_seconds: float) -> Dict[str, Any]:
        if not self.reuse_deepseek_tab:
            raise ValueError("close_reuse_tab() is only available when reuse_deepseek_tab=True")

        self._start_background_server()
        request_id = f"req-{uuid.uuid4()}"

        if not self._extension_connected.wait(timeout=self.connect_timeout_seconds):
            raise TimeoutError(
                f"Extension did not connect to ws://{self.ws_host}:{self.ws_port} within {self.connect_timeout_seconds}s"
            )

        loop = self._loop
        if loop is None:
            raise RuntimeError("Bridge event loop is not running")

        result_future: concurrent.futures.Future = concurrent.futures.Future()
        with self._state_lock:
            self._pending_results[request_id] = result_future

        try:
            send_future = asyncio.run_coroutine_threadsafe(
                self._send_close_reuse_tab(request_id),
                loop,
            )
            send_future.result(timeout=3)
        except Exception as e:
            with self._state_lock:
                self._pending_results.pop(request_id, None)
            raise RuntimeError(f"Failed to send close_reuse_tab to extension: {e}") from e

        try:
            response = result_future.result(timeout=timeout_seconds + 2)
        except concurrent.futures.TimeoutError as e:
            with self._state_lock:
                self._pending_results.pop(request_id, None)
            raise TimeoutError("Extension did not close reuse tab in time") from e

        if not isinstance(response, dict):
            raise RuntimeError("Invalid response from extension")
        return response

    def _task_payload(self, prompt: str, timeout_ms: int) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"task": prompt.strip(), "timeoutMs": timeout_ms}
        if self.reuse_deepseek_tab:
            payload["reuseDeepseekTab"] = True
        return payload

    def ask_raw(self, prompt: str, timeout_seconds: Optional[float] = None) -> Dict[str, Any]:
        if not isinstance(prompt, str) or not prompt.strip():
            raise ValueError("prompt must be a non-empty string")
        timeout_ms = int((timeout_seconds or self.request_timeout_seconds) * 1000)
        return self._request_sync(self._task_payload(prompt.strip(), timeout_ms), timeout_ms=timeout_ms)

    async def aask_raw(self, prompt: str, timeout_seconds: Optional[float] = None) -> Dict[str, Any]:
        if not isinstance(prompt, str) or not prompt.strip():
            raise ValueError("prompt must be a non-empty string")
        timeout_ms = int((timeout_seconds or self.request_timeout_seconds) * 1000)
        return await self._request_async(self._task_payload(prompt.strip(), timeout_ms), timeout_ms=timeout_ms)

    def ask(self, prompt: str, timeout_seconds: Optional[float] = None) -> str:
        result = self.ask_raw(prompt=prompt, timeout_seconds=timeout_seconds)
        if not isinstance(result, dict) or not result.get("ok"):
            raise RuntimeError(result.get("message") or result.get("error") or "DeepSeek failed")
        parsed_json = result.get("parsedJson")
        extracted = result.get("result") or _extract_result_from_json(parsed_json) or ""
        return extracted

    async def aask(self, prompt: str, timeout_seconds: Optional[float] = None) -> str:
        result = await self.aask_raw(prompt=prompt, timeout_seconds=timeout_seconds)
        if not isinstance(result, dict) or not result.get("ok"):
            raise RuntimeError(result.get("message") or result.get("error") or "DeepSeek failed")
        parsed_json = result.get("parsedJson")
        extracted = result.get("result") or _extract_result_from_json(parsed_json) or ""
        return extracted

    def close_reuse_tab(self, timeout_seconds: float = 15.0) -> None:
        result = self._close_reuse_tab_sync(timeout_seconds=timeout_seconds)
        if not isinstance(result, dict) or not result.get("ok"):
            raise RuntimeError(result.get("message") or result.get("error") or "close_reuse_tab failed")

    async def aclose_reuse_tab(self, timeout_seconds: float = 15.0) -> None:
        await asyncio.to_thread(self.close_reuse_tab, timeout_seconds)
