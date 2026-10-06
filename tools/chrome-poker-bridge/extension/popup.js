const bridge = 'http://127.0.0.1:44191';
const allowedOrigins = new Set(['https://poker.infinityf4p.com']);
const button = document.querySelector('#inspect');
const status = document.querySelector('#status');

function setStatus(message) {
  status.textContent = message;
}

button.addEventListener('click', async () => {
  button.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const pageUrl = tab?.url || '';
    const origin = new URL(pageUrl).origin;
    if (!allowedOrigins.has(origin)) throw new Error('当前标签页不是 Poker with Friends。');
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const clean = (value, limit) =>
          String(value || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, limit);
        const visible = (node) => {
          const style = getComputedStyle(node);
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            node.getBoundingClientRect().width > 0 &&
            node.getBoundingClientRect().height > 0
          );
        };
        const bodyText = clean(
          [...document.body.querySelectorAll('body *')]
            .filter(visible)
            .map((node) => (node.children.length === 0 ? node.textContent : ''))
            .join(' '),
          12000,
        );
        return {
          origin: location.origin,
          url: `${location.origin}${location.pathname}`.slice(0, 300),
          title: document.title,
          visibleText: bodyText,
          headings: [...document.querySelectorAll('h1,h2,h3,[role="heading"]')]
            .filter(visible)
            .map((node) => clean(node.textContent, 160))
            .filter(Boolean)
            .slice(0, 80),
          errorMessages: [
            ...document.querySelectorAll('[role="alert"],.error,.field-error,[data-error]'),
          ]
            .filter(visible)
            .map((node) => clean(node.textContent, 300))
            .filter(Boolean)
            .slice(0, 40),
          buttons: [...document.querySelectorAll('button,[role="button"]')]
            .filter(visible)
            .map((node) => clean(node.textContent || node.getAttribute('aria-label'), 120))
            .filter(Boolean)
            .slice(0, 80),
        };
      },
    });
    const response = await fetch(`${bridge}/snapshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(result),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || '桥接器拒绝了快照。');
    setStatus(
      `已读取：${body.snapshot.title || body.snapshot.url}\n${body.snapshot.errorMessages.length ? `页面提示：${body.snapshot.errorMessages.join('；')}` : '未发现可见错误提示。'}\n\n可在本机访问 /snapshot 查看脱敏结果。`,
    );
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '读取失败');
  } finally {
    button.disabled = false;
  }
});
