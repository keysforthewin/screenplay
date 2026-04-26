// Page-side helpers passed verbatim to mcp__chrome-devtools__evaluate_script.
// These run inside the Discord webapp's window. They MUST be self-contained
// (no imports, no closures over outer scope) because evaluate_script
// stringifies and reinjects them.

// Reads the latest message in the open channel. Returns the message id, the
// author flag (bot vs human), the visible text, and the URLs of any image /
// file attachments rendered in the message body.
//
// Discord renders messages as <li id="chat-messages-<channel>-<msgId>"> with
// the bot tag indicated by a class containing "botTag". Attachment URLs land
// in either <img src="...cdn.discordapp.com/attachments/..."> for inline
// images or <a href="...cdn.discordapp.com/attachments/..."> for file cards.
function readChannelState() {
  const items = document.querySelectorAll('li[id^="chat-messages-"]');
  if (items.length === 0) return { id: null, authorIsBot: false, text: '', imageUrls: [], fileLinks: [] };
  const last = items[items.length - 1];
  const contentEl = last.querySelector('[id^="message-content-"]');
  return {
    id: last.id,
    authorIsBot: !!last.querySelector('[class*="botTag"]'),
    text: contentEl ? contentEl.innerText : '',
    imageUrls: [...last.querySelectorAll('img[src*="cdn.discordapp.com/attachments"]')].map(i => i.src),
    fileLinks: [...last.querySelectorAll('a[href*="cdn.discordapp.com/attachments"]')].map(a => a.href),
  };
}

// Discord uses a Slate-based contenteditable for the channel message input.
// Standard form-control APIs do not work; we have to focus the element so
// keyboard events from type_text land in the editor's buffer.
function focusChannelInput() {
  const candidates = document.querySelectorAll('[role="textbox"][contenteditable="true"]');
  let editor = null;
  for (const el of candidates) {
    if (el.getAttribute('aria-label') && el.getAttribute('aria-label').toLowerCase().includes('message')) {
      editor = el;
      break;
    }
  }
  if (!editor) editor = candidates[0];
  if (!editor) return { focused: false, reason: 'no editor found' };
  editor.focus();
  return { focused: document.activeElement === editor, ariaLabel: editor.getAttribute('aria-label') };
}

module.exports = { readChannelState, focusChannelInput };
