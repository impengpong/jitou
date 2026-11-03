// 聊天监听模块 — MutationObserver + PDF 自动回复
const ChatMonitor = {
  observer: null,
  enabled: false,
  // HR 消息含这些关键词时自动发 PDF 简历
  resumeKeywords: ['简历', '附件', 'PDF', 'pdf', '清晰', '文件', '发我', '发一份', '发个', '再发', '详细的'],

  start() {
    if (this.observer) return;
    this.enabled = true;

    this.observer = new MutationObserver((mutations) => {
      if (!this.enabled) return;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) this.checkMessages(node);
        }
      }
    });

    // 监听聊天消息区域
    const chatArea = document.querySelector('.chat-main');
    const target = chatArea || document.body;
    this.observer.observe(target, { childList: true, subtree: true });

    // 初始检查已有消息
    this.checkMessages(target);
  },

  checkMessages(container) {
    const hrMessages = container.querySelectorAll
      ? container.querySelectorAll(SELECTORS.chatDetail.hrMessage)
      : [];
    hrMessages.forEach((msg) => this.processMessage(msg));
  },

  async processMessage(msgEl) {
    if (msgEl.dataset.zitouChecked) return;
    msgEl.dataset.zitouChecked = '1';

    const text = msgEl.textContent || '';
    const hasKeyword = this.resumeKeywords.some((kw) => text.includes(kw));
    if (!hasKeyword) return;

    // 通知 background
    chrome.runtime.sendMessage({ type: 'CHAT_DETECTED', text: text.slice(0, 100) });

    // 自动点"发简历"按钮，选第一份简历
    await this.sendResumeAttachment();
  },

  async sendResumeAttachment() {
    try {
      // 点"发简历"按钮
      const resumeBtn = document.querySelector(SELECTORS.chatDetail.resumeBtn);
      if (!resumeBtn) return;
      resumeBtn.click();
      await sleep(800);

      // 选第一份简历
      const item = document.querySelector(SELECTORS.chatDetail.resumeItem);
      if (!item) return;
      item.click();
      await sleep(300);

      // 确认发送
      const confirm = document.querySelector(SELECTORS.chatDetail.resumeConfirm);
      if (!confirm) return;
      confirm.click();

      chrome.runtime.sendMessage({ type: 'AUTO_REPLY_SENT', success: true });
    } catch (e) {
      chrome.runtime.sendMessage({ type: 'AUTO_REPLY_SENT', success: false, error: e.message });
    }
  },

  stop() {
    this.enabled = false;
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  },
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
