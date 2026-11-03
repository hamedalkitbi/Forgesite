/* SiteForge module: Payment Requests (subcontractors & suppliers).
 * Contract: docs/modules/CONTRACT.md — owner: payment-requests teammate.
 * Placeholder until the feature lands; keeps the app bootable meanwhile.
 */
(function () {
  'use strict';
  if (!window.SF) return;
  window.SF.registerView({
    id: 'payment-requests',
    nav: { section: 'project', icon: '🧾', label: 'Payment Requests', labelAr: 'طلبات الدفع' },
    roles: ['director', 'controller', 'super'],
    render: function (el) {
      el.innerHTML = '<h2 class="vt">🧾 Payment Requests</h2>' +
        '<div class="vsub">Module in progress</div>' +
        '<div class="card"><p class="mutc">Subcontractor and supplier payment requests will appear here.</p></div>';
    }
  });
})();
