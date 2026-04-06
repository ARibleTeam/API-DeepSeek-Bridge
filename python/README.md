# deepseek_bridge

Минималистичный Python-клиент для отправки запросов в браузерное расширение DeepSeek через локальный WebSocket.

## Как это работает

1. Вы создаете `DeepSeekBridge` в Python.
2. Клиент поднимает локальный WebSocket-сервер (по умолчанию `127.0.0.1:8765`).
3. Расширение подключается к этому сокету.
4. Python отправляет задачу (`task`) в расширение (опционально с флагом переиспользования вкладки).
5. Расширение открывает/использует DeepSeek в браузере и возвращает результат.

Клиент держит постоянное соединение с расширением, поэтому один и тот же экземпляр лучше переиспользовать для серии запросов.

### Режим одной вкладки (`reuse_deepseek_tab=True`)

По умолчанию после каждого ответа расширение **закрывает** вкладку DeepSeek. Если при создании клиента указать `reuse_deepseek_tab=True`, расширение **не закрывает** вкладку и следующие запросы идут в **тот же чат** (быстрее, без открытия новой вкладки каждый раз). Идентификатор вкладки хранится в памяти сервис-воркера; при перезапуске расширения или ручном закрытии вкладки будет открыта новая.

При `reuse_deepseek_tab=False` (по умолчанию) перед одноразовой задачей вкладка из режима reuse, если была, закрывается.

## Быстрый старт

```python
from deepseek_bridge import DeepSeekBridge

client = DeepSeekBridge(ws_port=8765)
answer = client.ask("Скажи, сколько будет 2+2")
print(answer)
```

## Назначение методов

Все методы делают одно и то же с точки зрения сети: отправляют текст задачи в расширение и ждут ответ. Отличаются **форматом результата** и **синхронностью**.

### Буква `a` в начале имени

- **`ask`**, **`ask_raw`**, **`close_reuse_tab`** — обычные (синхронные) функции: пока ответ не пришёл, поток Python **заблокирован** (удобно в скриптах и REPL).
- **`aask`**, **`aask_raw`**, **`aclose_reuse_tab`** — **асинхронные** (`async`/`await`): не блокируют event loop, их вызывают из `async def` (веб-серверы, GUI с asyncio, несколько задач в одном loop). По смыслу это те же операции, что версии без `a`.

### `ask` и `ask_raw` (и их `aask` / `aask_raw`)

| Метод | Что возвращает | Когда удобен |
|--------|----------------|--------------|
| **`ask`** / **`aask`** | Одна **строка** — уже извлечённый текст ответа | Обычный сценарий: задал вопрос — получил текст. При ошибке или `ok=False` — **исключение** (`RuntimeError`). |
| **`ask_raw`** / **`aask_raw`** | **Словарь** (`dict`) — полный ответ расширения по WebSocket | Нужны `requestId`, `sources`, `parsedJson`, поле `ok`, своё ветвление по ошибкам без исключения. |

Итого: **`ask`** = «дай мне строку»; **`ask_raw`** = «дай весь пакет как есть».

### `close_reuse_tab` и `aclose_reuse_tab`

Работают **только** если в конструкторе было `reuse_deepseek_tab=True`. Закрывают вкладку DeepSeek, которую расширение держит открытой между запросами (то же действие, что сообщение `deepseek_close_reuse_tab` по WebSocket, см. `extension/README.md`). Без режима reuse вызов даст **`ValueError`**.

## Примеры использования методов

Расширение должно быть в состоянии **Соединить** на том же `ws_host` / `ws_port`, иначе получите `TimeoutError` при ожидании подключения или ответа.

### Конструктор `DeepSeekBridge(...)`

Создаёт клиент и поднимает локальный WebSocket-сервер. Параметры (`ws_port`, таймауты, `reuse_deepseek_tab`) задают адрес подключения расширения и поведение вкладки.

```python
from deepseek_bridge import DeepSeekBridge

# минимально — только порт (хост по умолчанию 127.0.0.1)
client = DeepSeekBridge(ws_port=8765)

# все параметры
client = DeepSeekBridge(
    ws_host="127.0.0.1",
    ws_port=8765,
    request_timeout_seconds=180.0,
    connect_timeout_seconds=60.0,
    reuse_deepseek_tab=False,
)
```

### `ask`

Синхронно отправляет промпт и возвращает **только строку** с ответом (или бросает исключение при сбое).

```python
answer = client.ask("Объясни одним предложением, что такое список в Python")
print(answer)

# отдельный таймаут только для этого вызова (секунды)
answer = client.ask("Кратко: что такое asyncio", timeout_seconds=120.0)
```

### `ask_raw`

Синхронно отправляет промпт и возвращает **словарь** с полным ответом расширения (`ok`, `result`, `sources`, …).

```python
raw = client.ask_raw("Назови три города")
if raw.get("ok"):
    print("requestId:", raw.get("requestId"))
    print("result:", raw.get("result"))
    print("sources:", raw.get("sources"))
else:
    print("error:", raw.get("error"), raw.get("message"))
```

### `aask` и `aask_raw`

Асинхронные аналоги `ask` и `ask_raw`: те же типы возвращаемых значений, но вызываются через `await` внутри `async def`.

```python
import asyncio
from deepseek_bridge import DeepSeekBridge

async def main():
    client = DeepSeekBridge(ws_port=8765)
    text = await client.aask("Придумай имя для CLI-утилиты")
    print(text)
    raw = await client.aask_raw("Дай одно слово — цвет")
    print(raw)

asyncio.run(main())
```

### `close_reuse_tab` и `aclose_reuse_tab` (только при `reuse_deepseek_tab=True`)

Закрывают сохранённую вкладку DeepSeek. Синхронная и асинхронная формы — как с `ask` / `aask`.

```python
import asyncio
from deepseek_bridge import DeepSeekBridge

# несколько запросов в одном чате, затем закрыть вкладку из Python
client = DeepSeekBridge(ws_port=8765, reuse_deepseek_tab=True)
print(client.ask("Запомни число 42"))
print(client.ask("Какое число я просил запомнить?"))
client.close_reuse_tab()

# асинхронно
async def async_reuse():
    c = DeepSeekBridge(ws_port=8765, reuse_deepseek_tab=True)
    await c.aask("Скажи одно слово: привет")
    await c.aclose_reuse_tab()

asyncio.run(async_reuse())
```

Без `reuse_deepseek_tab=True` вызов `close_reuse_tab()` / `aclose_reuse_tab()` даст `ValueError`.

## Требования

- Python `>=3.9`
- Расширение запущено и включено (`Соединить`)
- Порт Python-клиента и порт расширения должны совпадать (обычно `8765`)

## API

Ниже — формальное описание параметров. Смысл имён (`ask` vs `ask_raw`, префикс `a`) см. в разделе **Назначение методов**.

### `DeepSeekBridge(...)`

Конструктор клиента: настройки адреса WebSocket-сервера, таймаутов и режима одной вкладки (`reuse_deepseek_tab`).

Параметры:

- `ws_host: str = "127.0.0.1"` - адрес локального WebSocket-сервера
- `ws_port: int = 8765` - порт локального WebSocket-сервера
- `request_timeout_seconds: float = 180.0` - таймаут выполнения одной задачи DeepSeek
- `connect_timeout_seconds: float = 60.0` - сколько ждать подключения расширения
- `reuse_deepseek_tab: bool = False` - не закрывать вкладку DeepSeek после ответа; следующие `ask` идут в тот же чат (см. выше)

Пример конструктора — в разделе **Примеры использования методов** (выше).

### `ask(prompt, timeout_seconds=None) -> str`

**Синхронно** отправляет текст задачи в расширение и возвращает **строку** с итоговым текстом ответа (без обёртки в `dict`). Если расширение вернуло ошибку — **`RuntimeError`**.

- `prompt: str` - текст задачи
- `timeout_seconds: float | None` - опциональный таймаут для конкретного вызова

Пример — в разделе **Примеры использования методов** (выше).

### `ask_raw(prompt, timeout_seconds=None) -> dict`

**Синхронно** отправляет задачу и возвращает **полный ответ расширения** в виде словаря (тот же JSON, что пришёл по WebSocket), без превращения в одну строку.

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

Пример — в разделе **Примеры использования методов** (выше).

### `aask(prompt, timeout_seconds=None) -> str`

**Асинхронная** версия `ask`: `await client.aask(...)` внутри `async def`. Возвращает **строку**; при ошибке — **`RuntimeError`**.

### `aask_raw(prompt, timeout_seconds=None) -> dict`

**Асинхронная** версия `ask_raw`: возвращает **словарь** с полным ответом расширения.

Примеры `aask` / `aask_raw` — в разделе **Примеры использования методов** (выше).

### `close_reuse_tab(timeout_seconds=15.0) -> None`

**Синхронно** просит расширение закрыть вкладку DeepSeek, сохранённую для режима **reuse**. Работает **только** при `reuse_deepseek_tab=True`; иначе **`ValueError`**.

По WebSocket уходит `deepseek_close_reuse_tab`, расширение отвечает `deepseek_close_reuse_tab_result`. При ошибке — `RuntimeError` или `TimeoutError`.

Примеры `close_reuse_tab` / `aclose_reuse_tab` — в разделе **Примеры использования методов** (выше).

### `aclose_reuse_tab(timeout_seconds=15.0) -> None`

**Асинхронная** версия `close_reuse_tab`: `await client.aclose_reuse_tab()` в `async`-коде.

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

- `ValueError` - пустой или некорректный `prompt`; вызов `close_reuse_tab()` при `reuse_deepseek_tab=False`
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
- Расширение выполняет **одну** задачу за раз; если прилетит несколько запросов подряд, лишние ждут в очереди (FIFO) на стороне расширения.

```python
client = DeepSeekBridge(ws_port=8765)
for task in tasks:
    print(client.ask(task))
```

