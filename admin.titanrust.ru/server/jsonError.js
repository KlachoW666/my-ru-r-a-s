'use strict';

function oneLine(value) {
  return String(value || '-').replace(/[\r\n\t]+/g, ' ').slice(0, 300);
}

function jsonErrorHandler({ logger = console } = {}) {
  return (error, req, res, next) => {
    const malformed = error?.type === 'entity.parse.failed'
      || (error instanceof SyntaxError && error?.status === 400 && Object.hasOwn(error, 'body'));
    if (!malformed) return next(error);

    logger.warn?.(
      `[JSON] Некорректное тело: ${oneLine(req.method)} ${oneLine(req.originalUrl || req.url)}`
      + ` origin=${oneLine(req.get?.('origin'))}`
    );
    const message = 'Запрос содержит некорректный JSON. Обновите страницу и повторите действие.';
    return res.status(400).json({
      success: false,
      code: 'INVALID_JSON',
      message,
      error: { code: 'INVALID_JSON', message }
    });
  };
}

module.exports = { jsonErrorHandler };
