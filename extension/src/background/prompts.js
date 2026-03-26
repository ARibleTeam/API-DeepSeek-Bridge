export function buildDirectAnswerPrompt(userTask) {
  const safeTask = String(userTask ?? '');
  return `Ты — помощник.
Верни ТОЛЬКО один JSON-объект строго в формате:
{
  "result": "строка"
}
Запрещено писать любой текст до/после JSON, запрещено markdown.
Задача пользователя:
${safeTask}`;
}

