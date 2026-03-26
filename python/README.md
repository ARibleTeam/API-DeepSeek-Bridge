# deepseek_bridge

Минималистичный Python-клиент для отправки запросов в браузерное расширение DeepSeek через локальный WebSocket.

## Как это работает

1. Вы создаете `DeepSeekBridge` в Python.
2. Клиент поднимает локальный WebSocket-сервер (по умолчанию `127.0.0.1:8765`).
3. Расширение подключается к этому сокету.
4. Python отправляет задачу (`task`) в расширение.
5. Расширение открывает/использует DeepSeek в браузере и возвращает результат.

Клиент держит постоянное соединение с расширением, поэтому один и тот же экземпляр лучше переиспользовать для серии запросов.

## Быстрый старт

```python
from deepseek_bridge import DeepSeekBridge

client = DeepSeekBridge(ws_port=8765)
answer = client.ask("Скажи, сколько будет 2+2")
print(answer)
```

## Требования

- Python `>=3.9`
- Расширение запущено и включено (`Соединить`)
- Порт Python-клиента и порт расширения должны совпадать (обычно `8765`)

## API

### `DeepSeekBridge(...)`

Конструктор клиента.

Параметры:

- `ws_host: str = "127.0.0.1"` - адрес локального WebSocket-сервера
- `ws_port: int = 8765` - порт локального WebSocket-сервера
- `request_timeout_seconds: float = 180.0` - таймаут выполнения одной задачи DeepSeek
- `connect_timeout_seconds: float = 60.0` - сколько ждать подключения расширения

Пример:

```python
client = DeepSeekBridge(
    ws_host="127.0.0.1",
    ws_port=8765,
    request_timeout_seconds=180,
    connect_timeout_seconds=60,
)
```

### `ask(prompt, timeout_seconds=None) -> str`

Отправляет задачу и возвращает только итоговый текст ответа.

- `prompt: str` - текст задачи
- `timeout_seconds: float | None` - опциональный таймаут для конкретного вызова

```python
text = client.ask("Составь краткий план изучения Python")
print(text)
```

### `ask_raw(prompt, timeout_seconds=None) -> dict`

Отправляет задачу и возвращает сырой ответ расширения.

Что такое "сырой ответ":

- это JSON-объект, который пришел от браузерного расширения по WebSocket;
- Python-клиент его не упрощает до строки, а отдает как есть.

Когда использовать:

- если достаточно только текста ответа - используй `ask(...)`;
- если нужна отладка или метаданные запроса - используй `ask_raw(...)`.

Примеры полезных полей:

- `requestId` - идентификатор запроса (удобно связывать Python-логи и логи расширения);
- `parsedJson` - структурированный JSON-ответ DeepSeek до извлечения итогового текста;
- `sources` - ссылки/источники из ответа (если DeepSeek их вернул);
- `error` и `message` - подробности ошибки, если `ok=False`.

```python
raw = client.ask_raw("Назови 5 идей для проекта")
print(raw)
```

### `aask(prompt, timeout_seconds=None) -> str`

Асинхронная версия `ask`.

### `aask_raw(prompt, timeout_seconds=None) -> dict`

Асинхронная версия `ask_raw`.

Пример async:

```python
import asyncio
from deepseek_bridge import DeepSeekBridge

async def main():
    client = DeepSeekBridge(ws_port=8765)
    answer = await client.aask("Придумай имя для pet-проекта")
    print(answer)

asyncio.run(main())
```

## Формат raw-ответа

Типичный ответ `ask_raw(...)`:

```python
{
    "type": "deepseek_task_result",
    "requestId": "req-...",
    "ok": True,
    "result": "...",
    "parsedJson": {...},
    "sources": [...]
}
```

Основные поля:

- `ok: bool` - успешность выполнения
- `result: str | None` - извлеченный итоговый текст
- `parsedJson: dict | None` - JSON, который вернул DeepSeek
- `sources: list` - список источников (если режим DeepSeek их вернул)
- `error: str | None` - код ошибки (если `ok=False`)
- `message: str | None` - текст ошибки (если `ok=False`)
- `requestId: str` - id запроса для трассировки

## Ошибки и исключения

Клиент может выбросить:

- `ValueError` - пустой или некорректный `prompt`
- `TimeoutError` - не подключилось расширение или задача превысила таймаут
- `RuntimeError` - ошибки транспорта/расширения (`ok=False`, invalid response, send failed)

Рекомендуется оборачивать вызовы:

```python
try:
    print(client.ask("Привет"))
except TimeoutError as e:
    print("Таймаут:", e)
except RuntimeError as e:
    print("Ошибка bridge:", e)
```

## Рекомендации по производительности

- Создавай клиент один раз и переиспользуй.
- Не создавай новый `DeepSeekBridge` на каждый запрос.
- Держи расширение в состоянии `Соединить`.

```python
client = DeepSeekBridge(ws_port=8765)
for task in tasks:
    print(client.ask(task))
```

