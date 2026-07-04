const axios = require('axios');
const { telegramBotToken } = require('../config');

async function sendTelegramMessage(chatId, text, httpClient = axios) {
  await httpClient.post(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
    chat_id: chatId,
    text,
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

module.exports = { sendTelegramMessage, downloadTelegramFile };
