const axios = require('axios');
const { telegramBotToken } = require('../config');

async function sendTelegramMessage(chatId, text, httpClient = axios) {
  await httpClient.post(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
    chat_id: chatId,
    text,
  });
}

// One button per row -- the labels are dates, and stacking keeps them readable
// on a phone without truncation.
async function sendTelegramButtons(chatId, text, buttons, httpClient = axios) {
  const response = await httpClient.post(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
    chat_id: chatId,
    text,
    reply_markup: { inline_keyboard: buttons.map(b => [b]) },
  });
  return response.data.result.message_id;
}

// Replaces the question with its outcome. Sending no reply_markup strips the
// buttons, so a confirmation can never be tapped twice.
async function editTelegramMessage(chatId, messageId, text, httpClient = axios) {
  await httpClient.post(`https://api.telegram.org/bot${telegramBotToken}/editMessageText`, {
    chat_id: chatId,
    message_id: messageId,
    text,
  });
}

// Telegram spins the button until this is called, so it must run on every
// callback -- including the expired and cancelled paths.
async function answerCallbackQuery(callbackQueryId, httpClient = axios) {
  await httpClient.post(`https://api.telegram.org/bot${telegramBotToken}/answerCallbackQuery`, {
    callback_query_id: callbackQueryId,
  });
}

async function downloadTelegramFile(fileId, httpClient = axios) {
  const getFileResponse = await httpClient.get(`https://api.telegram.org/bot${telegramBotToken}/getFile`, {
    params: { file_id: fileId },
  });
  const filePath = getFileResponse.data.result.file_path;
  const fileResponse = await httpClient.get(`https://api.telegram.org/file/bot${telegramBotToken}/${filePath}`, {
    responseType: 'arraybuffer',
  });
  return Buffer.from(fileResponse.data);
}

module.exports = {
  sendTelegramMessage,
  sendTelegramButtons,
  editTelegramMessage,
  answerCallbackQuery,
  downloadTelegramFile,
};
