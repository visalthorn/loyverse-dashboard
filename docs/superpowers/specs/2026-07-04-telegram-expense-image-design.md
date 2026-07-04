# Telegram Expense Bot — Image Extraction — Design

## Goal

Extend the existing Telegram expense bot ([2026-07-04-telegram-expense-bot-design.md](2026-07-04-telegram-expense-bot-design.md)) so the Poipet GM can drop a photo of a receipt or invoice into the group, instead of typing the expense out. The bot should extract the same structured data (date, amount(s), remark(s), currency) from the image via Claude vision, and insert it through the exact same path as text-derived expenses.

Scope: **receipt/invoice photo extraction only.** No image storage, no support for images sent as uncompressed files (`message.document`), no special handling for multi-photo albums.

## Architecture

Reuses the existing pipeline end to end — `extractMessage` → `handleTelegramMessage` → `insertExpense` → reply — with two additions and one small extension:

1. **`extractMessage()`** (`routes/telegram.js`) currently returns `null` for any update without a string `message.text`. Extended to also recognize `message.photo` (Telegram's array of compressed JPEG resolutions for a photo message). When present: `text` becomes `message.caption` (may be `null`), and a new `photoFileId` field holds the `file_id` of the **largest** entry in `message.photo` (last element — Telegram orders the array smallest to largest). Forward-date resolution and the `telegram_message_id`-based duplicate check are untouched — both already key off fields that photo messages also carry (`forward_origin`/`forward_date`, `message_id`).

2. **`downloadTelegramFile(fileId, httpClient = axios)`** — new function in `services/telegramBot.js` (already the Bot-API wrapper). Calls `GET https://api.telegram.org/bot<token>/getFile?file_id=<fileId>` to resolve a `file_path`, then downloads the raw bytes from `https://api.telegram.org/file/bot<token>/<file_path>` as a `Buffer`. Media type is hardcoded to `image/jpeg` — Telegram always serves `message.photo` entries as JPEG, so no sniffing is needed.

3. **`parseExpenseImage(caption, imageBase64, referenceDate, anthropicClient)`** — new function in `services/telegramParser.js`, a sibling to the existing `parseExpenseMessage`, not a merged/branching rewrite of it. Both functions share the same `OUTPUT_SCHEMA` (`{ type, date, items[] }`) and call the same model (`claude-haiku-4-5`, per existing convention — kept consistent with the text path rather than upgraded, to keep per-message cost negligible). The system prompt is reworded to acknowledge both input shapes ("...may be text, or a photo of a receipt/invoice...") but stays otherwise the same. A receipt with several line items naturally produces multiple `items` entries — reusing the multi-expense-per-message support the text path already has, with no schema change.

   The Claude call sends the image as a `base64` image content block followed by a text block containing the reference date and (if present) the caption:

   ```js
   messages: [{
     role: 'user',
     content: [
       { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
       { type: 'text', text: `Reference date (today, or the date this message was originally sent if it was forwarded): ${referenceDate}${caption ? `\n\nCaption: ${caption}` : ''}` },
     ],
   }]
   ```

4. **`handleTelegramMessage`** gets one new branch at the top: if `photoFileId` is present, download the image via `downloadTelegramFile`, base64-encode the returned buffer, and call `parseExpenseImage` instead of `parseExpenseMessage`. Every step after parsing — `not_expense`/`unclear` handling, date resolution (`parsed.date || referenceDate`), USD→KHR conversion, `insertExpense`, and the confirmation reply — is identical code, shared between both paths.

## Image storage

**Not stored.** The downloaded image lives only in memory for the duration of the request — it's base64-encoded, sent to Claude, and discarded once the reply is sent. No new column, no upload directory, no storage bucket. If a logged expense looks wrong, the family's existing fallback is the original photo still sitting in the Telegram group's chat history — same as it works today for text.

## Scope boundaries

- Only `message.photo` (Telegram's compressed photo array) is handled. `message.document` (an image sent as an uncompressed "file") is out of scope — a different code path with arbitrary MIME types, not needed for this iteration.
- Telegram albums (multiple photos sent together) arrive as **separate webhook updates that share a `media_group_id`** — each is processed as its own independent message. A 3-photo receipt album becomes 3 separate expense attempts, not one merged one. This is a known limitation, not solved here.
- No new DB columns. `source = 'telegram'` and `telegram_message_id` are reused exactly as they are for text-derived expenses.

## Error handling

Mirrors the text path exactly — no new error states:

- Download failure (network error, expired file, etc.) or a Claude vision-call failure → the existing "Having trouble right now — please try again in a bit" reply; error logged server-side.
- A photo that isn't a receipt (family photo, meme, etc.) → classified `not_expense`, ignored silently, same as casual text chat.
- A blurry/ambiguous photo Claude can't confidently extract from → `unclear`, same Khmer clarification reply asking her to type it instead (`ចំណាយ 2/7/26 14000៛`).

## Testing

- Unit tests for `parseExpenseImage` against a mocked Anthropic client, following the same fixture-based pattern as the existing `parseExpenseMessage` tests (clean single-item receipt, multi-item receipt, non-receipt image, ambiguous image, an image with a caption supplying context/date).
- Unit tests for `downloadTelegramFile` against a mocked axios client (`getFile` call, then file download), following the same injectable-`httpClient` pattern already used in `sendTelegramMessage`.
- Unit tests for `extractMessage`'s photo-detection branch: picks the largest `photo` entry's `file_id`, uses `caption` as `text` (including when caption is absent), and leaves the existing text-message behavior unchanged.
- Unit tests for `handleTelegramMessage`'s new photo branch (mocked `downloadTelegramFile` + `parseExpenseImage`): successful multi-item insert, `not_expense`, `unclear`, and download/parse failure.

## Out of scope (for this iteration)

- Storing or serving the original receipt image anywhere.
- `message.document`-based image uploads (uncompressed "send as file").
- Merging multi-photo albums (`media_group_id`) into a single expense entry.
- Any model upgrade beyond `claude-haiku-4-5` for vision.
