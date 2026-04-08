from pathlib import Path

from deepseek_bridge import DeepSeekBridge


BASE_DIR = Path(__file__).resolve().parent
INPUT_DIR = BASE_DIR / "input"
OUTPUT_DIR = BASE_DIR / "output"
INPUT_FILE = INPUT_DIR / "input.txt"
OUTPUT_FILE = OUTPUT_DIR / "output.txt"


def ensure_paths() -> None:
    INPUT_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    if not INPUT_FILE.exists():
        INPUT_FILE.write_text(
            "Напиши короткий ответ на эту задачу.",
            encoding="utf-8",
        )
    if not OUTPUT_FILE.exists():
        OUTPUT_FILE.write_text("", encoding="utf-8")


def main() -> None:
    ensure_paths()

    task = INPUT_FILE.read_text(encoding="utf-8").strip()
    if not task:
        INPUT_FILE.write_text(
            "Напиши здесь задачу для ИИ и запусти скрипт снова.",
            encoding="utf-8",
        )
        raise ValueError(
            f"Файл '{INPUT_FILE}' пуст. Шаблон задачи добавлен автоматически."
        )

    client = DeepSeekBridge(ws_host="127.0.0.1", ws_port=8765)
    result = client.ask(task)
    OUTPUT_FILE.write_text(result, encoding="utf-8")

    print(f"Задача прочитана из: {INPUT_FILE}")
    print(f"Ответ записан в: {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
