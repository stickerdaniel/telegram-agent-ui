# Facts

Records of what Telegram does, taken before any package code. Each rule of the design that rests on server or client behaviour points here. `probe.ts` and `listen.ts` produced the files in `records/` on 2026-11-17 against the cloud Bot API 10.4, in a private chat. Chat id, account ids and names are replaced.

## Recorded

| Fact | Record | Result |
| --- | --- | --- |
| A rich message with a table, a details block and an inline keyboard of 3 styled buttons is one `sendRichMessage` | `01-send-rich-with-keyboard.json` | 200. The answer holds the body as `rich_message.blocks`, whatever form was sent |
| An edit that changes nothing | `02-edit-unchanged.json` | 400, "message is not modified" |
| `editMessageText` with a new body and no `reply_markup` | `03-edit-without-reply-markup.json` | 200, and the keyboard is gone. Every edit has to send the full keyboard again |
| The same edit with the keyboard and a changed button text | `04-edit-with-mark.json` | 200, the keyboard is back |
| Two long polls on one token | `05-two-polls.json` | The older poll ends with 409, the newer one answers 200 |
| An album of 3 photos as a reply to the body | `06-album-reply-to-body.json` | 200, 3 messages with one `media_group_id`, each with `reply_to_message` set to the body. `reply_to_message` carries the body's `reply_markup` |
| A document as a second reply to the same body | `07-document-reply-to-body.json` | 200, anchored on the body, not on the album |
| A caption of 1,025 characters | `08-caption-1025.json` | 400, "message caption is too long" |
| A tap on a button by a person on iOS | `09-human-updates.json` | A `callback_query` with the button's `data` and the whole message, `reply_markup` included |
| A reply written by a person on iOS | `09-human-updates.json` | `reply_to_message` holds the question with its `reply_markup`, so the callback data of its buttons names the question |
| An album with one image the server cannot read | first run, not kept | 400 for the whole request, `failed to send message #2 with the error message "IMAGE_PROCESS_FAILED"` |

## Screens

An agent takes every device screenshot itself: the desktop one from Telegram on the Mac, the iOS one on the connected iPhone, the Android one in an emulator. No person is asked for one.

| Client | State | Result |
| --- | --- | --- |
| Telegram for macOS | `screens/desktop-macos.png` | The table draws with borders and a shaded second row, the details block folds, the 3 buttons take the styles `primary` and `danger`, and the album and the document both show the quoted body they reply to |
| Telegram for iOS 18, dark theme | `screens/ios.png` | The table draws with a header row and cell borders in the width of the phone, the details block folds, the 3 buttons take their styles, and the mark on the first button shows |
| Telegram for Android | open | No emulator image exists on the Mac, and the app needs a signed-in account there too |

## Open

- The Android screen above.
- Launch data carries `signature`.
- A page inside the view cannot read launch data, and a link or a refresh inside it loads nothing.
- How long a new stored view takes to show on the phone.
