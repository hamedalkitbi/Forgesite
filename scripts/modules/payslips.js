/* SiteForge module: Payroll Payslips.
 * Contract: docs/modules/CONTRACT.md — owner: payslips teammate.
 * Placeholder until the feature lands; keeps the app bootable meanwhile.
 */
(function () {
  'use strict';
  if (!window.SF) return;
  window.SF.registerView({
    id: 'payslips',
    nav: { section: 'project', icon: '🧾', label: 'Payslips', labelAr: 'قسائم الرواتب' },
    roles: ['director', 'controller'],
    render: function (el) {
      el.innerHTML = '<h2 class="vt">🧾 Payslips</h2>' +
        '<div class="vsub">Module in progress</div>' +
        '<div class="card"><p class="mutc">Printable payslips per worker and period will appear here.</p></div>';
    }
  });
})();
