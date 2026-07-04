const axios = require('axios');
const { telegramBotToken } = require('../config');

async function sendTelegramMessage(chatId, text, httpClient = axios) {
  await httpClient.post(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
    chat_id: chatId,
    text,
  });
}

module.exports = { sendTelegramMessage };
