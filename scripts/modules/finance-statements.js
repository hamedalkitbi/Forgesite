/* SiteForge module: Financial Statements (AR / AP / Balance Sheet).
 * Contract: docs/modules/CONTRACT.md — owner: finance teammate.
 * Placeholder until the feature lands; keeps the app bootable meanwhile.
 */
(function () {
  'use strict';
  if (!window.SF) return;
  window.SF.registerView({
    id: 'finance',
    nav: { section: 'company', icon: '📊', label: 'Financial Accounts', labelAr: 'الحسابات المالية' },
    roles: ['director', 'controller'],
    render: function (el) {
      el.innerHTML = '<h2 class="vt">📊 Financial Accounts</h2>' +
        '<div class="vsub">Module in progress</div>' +
        '<div class="card"><p class="mutc">Balance sheet, receivables and payables will appear here.</p></div>';
    }
  });
})();
