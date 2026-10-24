const UI = {
  toast(message, type = 'info') {
    let root = document.getElementById('toast-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'toast-root';
      document.body.appendChild(root);
    }
    const el = document.createElement('div');
    el.className = `toast ${type === 'error' ? 'err' : type === 'success' ? 'ok' : ''}`;
    el.textContent = message;
    root.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  },

  confirm(message, { title = 'Are you sure?', confirmText = 'Confirm' } = {}) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true" style="max-width:480px">
          <h3>${title}</h3>
          <p>${message}</p>
          <div class="modal-actions">
            <button class="btn btn-secondary" data-act="cancel">Cancel</button>
            <button class="btn" data-act="ok">${UI.esc(confirmText)}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay || e.target.closest('[data-act="cancel"]')) { overlay.remove(); resolve(false); }
        if (e.target.closest('[data-act="ok"]')) { overlay.remove(); resolve(true); }
      });
      overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.closest('[data-act="ok"]')) { e.preventDefault(); overlay.remove(); resolve(true); }
        if (e.key === 'Escape') { e.preventDefault(); overlay.remove(); resolve(false); }
      });
    });
  },

  /** Promise-based input dialog (native prompt() is unavailable in the desktop preview). */
  prompt(message, { title = 'Input required', placeholder = '', value = '', multiline = false, confirmText = 'OK', required = true, type = 'text' } = {}) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true" style="max-width:480px">
          <h3>${title}</h3>
          <p>${message}</p>
          ${multiline
            ? `<textarea id="ui-prompt-input" placeholder="${UI.esc(placeholder)}"></textarea>`
            : `<input id="ui-prompt-input" type="${UI.esc(type)}" placeholder="${UI.esc(placeholder)}">`}
          <div class="field-error" id="ui-prompt-error" style="display:none"></div>
          <div class="modal-actions">
            <button class="btn btn-secondary" data-act="cancel">Cancel</button>
            <button class="btn" data-act="ok">${UI.esc(confirmText)}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const input = overlay.querySelector('#ui-prompt-input');
      const errEl = overlay.querySelector('#ui-prompt-error');
      input.value = value || '';
      const close = (val) => { overlay.remove(); resolve(val); };
      const submit = () => {
        const v = input.value.trim();
        if (required && !v) {
          errEl.textContent = 'This field is required.';
          errEl.style.display = 'block';
          input.focus();
          return;
        }
        close(v);
      };
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay || e.target.closest('[data-act="cancel"]')) close(null);
        if (e.target.closest('[data-act="ok"]')) submit();
      });
      overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); close(null); }
        if (e.key === 'Enter' && (e.target.closest('[data-act="ok"]') || (e.target === input && (!multiline || e.ctrlKey || e.metaKey)))) {
          e.preventDefault();
          submit();
        }
      });
      input.focus();
    });
  },

  /** Promise-based single-choice picker (used by reporting flow).
    Returns the chosen label, or null if the user cancels. */
  pickOne(message, options) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true" style="max-width:480px">
          <h3>${UI.esc(message)}</h3>
          <div class="report-reasons">${options.map((o) =>
            `<button type="button" class="report-reason-btn">${UI.esc(o)}</button>`
          ).join('')}</div>
          <div class="modal-actions">
            <button class="btn btn-secondary" data-act="cancel">Cancel</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const btns = overlay.querySelectorAll('.report-reason-btn');
      const done = (val) => { overlay.remove(); resolve(val); };
      btns.forEach((b) => b.addEventListener('click', () => done(b.textContent)));
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay || e.target.closest('[data-act="cancel"]')) done(null);
      });
      overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') done(null);
      });
    });
  },

  /** Promise-based notice dialog (native alert() is unavailable in the desktop preview). */
  alert(message, { title = 'Notice', okText = 'OK' } = {}) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true" style="max-width:480px">
          <h3>${title}</h3>
          <p>${message}</p>
          <div class="modal-actions">
            <button class="btn" data-act="ok">${UI.esc(okText)}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay || e.target.closest('[data-act="ok"]')) { overlay.remove(); resolve(true); }
      });
      overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); overlay.remove(); resolve(true); }
      });
    });
  },

  fmtDate(d) {
    if (!d) return '-';
    const date = new Date(d);
    if (isNaN(date)) return d;
    return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  },

  fmtDateTime(d) {
    if (!d) return '-';
    const date = new Date(d);
    if (isNaN(date)) return d;
    return date.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  },

  fmtTime(t) {
    if (!t) return '';
    const [h, m] = String(t).split(':');
    const hour = parseInt(h, 10);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const h12 = hour % 12 || 12;
    return `${h12}:${m} ${ampm}`;
  },

  timeAgo(d) {
    const s = (Date.now() - new Date(d).getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
    if (s < 604800) return `${Math.floor(s / 86400)} days ago`;
    return this.fmtDate(d);
  },

  positionLabel(p) {
    return {
      '1ST_PLACE': '1st Place', '2ND_PLACE': '2nd Place', '3RD_PLACE': '3rd Place',
      'FINALIST': 'Finalist', 'PARTICIPATION': 'Participation', 'OTHER': 'Other',
    }[p] || (p || '-');
  },

  categoryLabel(c) {
    return String(c || '').replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
  },

  statusBadge(status) {
    const map = {
      // events / requests
      PENDING: ['amber', 'Pending'], UNDER_REVIEW: ['blue', 'Under Review'],
      APPROVED: ['green', 'Approved'], REJECTED: ['red', 'Rejected'],
      CHANGES_REQUESTED: ['amber', 'Changes Requested'],
      SCHEDULED: ['teal', 'Scheduled'], ONGOING: ['teal', 'Ongoing'],
      COMPLETED: ['gray', 'Completed'], CANCELLED: ['red', 'Cancelled'],
      // registrations
      REGISTERED: ['green', 'Registered'], CANCELLED: ['red', 'Cancelled'],
      // clubs
      OPEN: ['green', 'Open'], CLOSED: ['red', 'Closed'],
      ACTIVE: ['green', 'Active'], INACTIVE: ['gray', 'Inactive'],
      SUBMITTED: ['amber', 'Submitted'],
      // complaints
      ASSIGNED: ['blue', 'Assigned'], IN_PROGRESS: ['blue', 'In Progress'],
      RESOLVED: ['green', 'Resolved'], CLOSED: ['gray', 'Closed'], REOPENED: ['red', 'Reopened'],
      // achievements
      VERIFIED: ['green', 'Verified'], PENDING_VERIFICATION: ['amber', 'Pending Verification'],
      // members
      MEMBER: ['gray', 'Member'], CORE_MEMBER: ['blue', 'Core Member'],
      STUDENT_COORDINATOR: ['teal', 'Coordinator'],
      // priorities
      LOW: ['gray', 'Low'], MEDIUM: ['blue', 'Medium'], HIGH: ['amber', 'High'], URGENT: ['red', 'Urgent'],
      // misc
      INDIVIDUAL: ['gray', 'Individual'], TEAM: ['teal', 'Team'], TEAM_MEMBER: ['gray', 'Team Member'],
    };
    const [cls, label] = map[status] || ['gray', UI.categoryLabel(status)];
    return `<span class="badge badge-${cls}">${label}</span>`;
  },

  esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  empty(title, hint = '') {
    return `<div class="empty"><b>${title}</b>${hint ? `<span>${hint}</span>` : ''}</div>`;
  },

  loadingBox(text = 'Loading...') {
    return `<div class="loading">${text}</div>`;
  },

  eventCard(ev, opts = {}) {
    const poster = ev.poster_path
      ? `style="background-image:url('${UI.esc(ev.poster_path)}')"`
      : '';
    const posterText = ev.poster_path ? '' : UI.esc(UI.categoryLabel(ev.category));
    const seatsLeft = Math.max(0, (ev.max_participants || 0) - (ev.registration_count || 0));
    const desc = UI.esc(String(ev.description || '').replace(/\s+/g, ' ').trim());
    const shortDesc = desc.length > 110 ? `${desc.slice(0, 110)}...` : desc;

    // Register button state (students; other roles see View Details only)
    const user = Auth.user();
    const isStudent = !!(user && user.role === 'STUDENT');
    const ended = ev.status === 'CANCELLED' || ev.status === 'COMPLETED';
    const deadlinePassed = ev.registration_deadline && new Date(ev.registration_deadline) < new Date();
    const full = ev.max_participants != null && seatsLeft <= 0;
    let regBtn = '';
    if (opts.registered) {
      regBtn = `<button class="btn btn-sm btn-secondary" disabled>Registered &#10003;</button>`;
    } else if (opts.register !== false && isStudent && !ended && !deadlinePassed && !full) {
      regBtn = `<button class="btn btn-sm ec-register" data-event-id="${ev.id}">Register Now</button>`;
    } else if (opts.register !== false && isStudent && full && !ended && !deadlinePassed) {
      regBtn = `<button class="btn btn-sm btn-secondary" disabled>Full</button>`;
    }

    // Official events (verified college / club organiser) must never look like
    // a student-run event, so every card carries an explicit ribbon.
    const official = Number(ev.is_official) === 1;
    const ribbon = official
      ? '<span class="ev-ribbon official">&#10003; OFFICIAL EVENT</span>'
      : '<span class="ev-ribbon student">STUDENT EVENT</span>';

    return `
      <div class="card event-card${official ? ' is-official' : ''}">
        <div class="ec-poster" ${poster}>${posterText}${ribbon}</div>
        <div class="ec-body">
          <a class="ec-title" href="/event-details.html?id=${ev.id}">${UI.esc(ev.title)}</a>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${UI.statusBadge(ev.category)}${ev.event_type ? UI.statusBadge(ev.event_type) : ''}
          </div>
          ${shortDesc ? `<div class="ec-desc">${shortDesc}</div>` : ''}
          <div class="ec-meta">
            <span>${UI.fmtDate(ev.event_date)} &middot; ${UI.fmtTime(ev.start_time)}${ev.end_time ? ` - ${UI.fmtTime(ev.end_time)}` : ''}</span>
            <span>${UI.esc(ev.venue)}</span>
            ${ev.organizer_name ? `<span>by ${UI.esc(ev.organizer_name)}${ev.club_name ? ` · ${UI.esc(ev.club_name)}` : ''}</span>` : ''}
          </div>
          <div class="ec-foot">
            <span class="seats">${ev.registration_count || 0} registered${ev.max_participants ? ` · ${seatsLeft} seats left` : ''}${ev.interest_count ? ` · ${ev.interest_count} interested` : ''}</span>
            <span class="seats">${ev.registration_deadline ? `Deadline: ${UI.fmtDate(ev.registration_deadline)}` : ''}</span>
          </div>
          <div class="ec-actions">
            <a class="btn btn-sm btn-secondary" href="/event-details.html?id=${ev.id}">View Details</a>
            ${regBtn}
          </div>
        </div>
      </div>`;
  },

  /** Wire up all "Register Now" buttons inside a container (one-click register). */
  bindRegisterButtons(container, afterRegister) {
    container.querySelectorAll('.ec-register').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.eventId;
        btn.disabled = true;
        try {
          const res = await API.post(`/events/${id}/register`);
          UI.toast(res.message || 'Registered successfully', 'success');
          btn.outerHTML = '<button class="btn btn-sm btn-secondary" disabled>Registered &#10003;</button>';
          if (afterRegister) afterRegister(id);
        } catch (err) {
          UI.toast(err.message, 'error');
          btn.disabled = false;
        }
      });
    });
  },

  clubCard(club) {
    const logo = club.logo_path
      ? `style="background-image:url('${UI.esc(club.logo_path)}')"`
      : '';
    const logoText = club.logo_path ? '' : UI.esc(club.name.charAt(0));
    return `
      <div class="card event-card">
        <div class="ec-poster" ${logo}>${logoText}</div>
        <div class="ec-body">
          <a class="ec-title" href="/club-details.html?id=${club.id}">${UI.esc(club.name)}</a>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${UI.statusBadge(club.category)}${UI.statusBadge(club.recruitment_status)}
          </div>
          <div class="ec-meta"><span>${UI.esc((club.description || '').slice(0, 110))}${(club.description || '').length > 110 ? '...' : ''}</span></div>
          <div class="ec-foot">
            <span class="seats">${club.member_count} members</span>
            <a class="btn btn-sm" href="/club-details.html?id=${club.id}">View</a>
          </div>
        </div>
      </div>`;
  },

  barChart(containerId, rows, labelKey, valueKey, maxValue) {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (!rows.length) { el.innerHTML = UI.empty('No data yet'); return; }
    const max = maxValue || Math.max(...rows.map((r) => r[valueKey]), 1);
    el.innerHTML = `<div class="chart-bars">${rows.map((r) => `
      <div class="cb-row">
        <span>${UI.esc(UI.categoryLabel(r[labelKey]))}</span>
        <span class="cb-track"><span class="cb-fill" style="width:${Math.round((r[valueKey] / max) * 100)}%"></span></span>
        <span class="cb-num">${r[valueKey]}</span>
      </div>`).join('')}</div>`;
  },
};

/* Press ripple: a light touch of feedback on primary controls (skipped when
   the user prefers reduced motion). */
UI.bindRipple = function () {
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const el = e.target.closest('.btn, .pa-btn, .tool-btn, .trend-tag, .create-menu button, .tab-ind');
    if (!el || el.disabled) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const r = el.getBoundingClientRect();
    const size = Math.max(r.width, r.height) * 1.1;
    const span = document.createElement('span');
    span.className = 'ripple';
    span.setAttribute('aria-hidden', 'true');
    span.style.width = span.style.height = `${Math.round(size)}px`;
    span.style.left = `${Math.round(e.clientX - r.left - size / 2)}px`;
    span.style.top = `${Math.round(e.clientY - r.top - size / 2)}px`;
    el.appendChild(span);
    setTimeout(() => span.remove(), 650);
  }, { passive: true });
};
UI.bindRipple();

/* Dark / light theme toggle (social layer) */
UI.theme = {
  // Deep navy is the product identity, so dark is the default first impression.
  get() { return localStorage.getItem('cc_theme') || 'dark'; },
  apply(t) {
    document.documentElement.setAttribute('data-theme', t);
    document.querySelectorAll('.theme-toggle').forEach((b) => { b.textContent = t === 'dark' ? '☀️' : '🌙'; });
  },
  /** Set and persist an explicit theme (used by the profile settings tab). */
  set(t) {
    localStorage.setItem('cc_theme', t === 'dark' ? 'dark' : 'light');
    this.apply(this.get());
  },
  toggle() {
    const t = this.get() === 'dark' ? 'light' : 'dark';
    localStorage.setItem('cc_theme', t);
    this.apply(t);
  },
  init() {
    this.apply(this.get());
    document.addEventListener('click', (e) => {
      if (e.target.closest('.theme-toggle')) { e.preventDefault(); this.toggle(); }
    });
  },
};
UI.theme.init();

/* Unread-notification badge: shared by the topnav bell and the sidebar nav. */
UI._notifCount = null;
UI.setNotifBadge = function (n) {
  const count = Number(n) || 0;
  const grew = UI._notifCount != null && count > UI._notifCount;
  UI._notifCount = count;
  const label = count > 99 ? '99+' : String(count);
  const el = document.getElementById('notif-count');
  if (el) {
    el.textContent = label;
    el.style.display = count > 0 ? 'inline-flex' : 'none';
    el.classList.toggle('badge-pill', count > 9);
  }
  const tags = document.querySelectorAll('[data-notif-badge]');
  tags.forEach((b) => {
    b.textContent = label;
    b.style.display = count > 0 ? 'inline-flex' : 'none';
  });
  // A fresh notification makes the badge pop, so the change is unmissable.
  if (grew) {
    [el, ...tags].filter(Boolean).forEach((b) => {
      b.classList.remove('bump-badge');
      void b.offsetWidth;
      b.classList.add('bump-badge');
    });
  }
};

UI.refreshNotifBadge = async function () {
  if (!Auth.user()) return;
  try {
    const res = await API.get('/notifications/unread-count');
    const d = res.data || {};
    UI.setNotifBadge(d.unread != null ? d.unread : d.count);
  } catch (_e) { /* badge is best-effort */ }
};

/* Shared chrome: nav + footer injection for every page */
document.addEventListener('DOMContentLoaded', async () => {
  const mount = document.getElementById('app-nav');
  if (mount) {
    const user = Auth.user();
    const path = location.pathname;
    const link = (href, label, match) => {
      const active = match.some((m) => (m === '/' ? path === '/' || path === '/index.html' : path.startsWith(m)));
      return `<a href="${href}" class="${active ? 'active' : ''}">${label}</a>`;
    };
    let links = '';
    if (user) {
      links = [
        link('/feed.html', 'Feed', ['/feed.html', '/profile.html']),
        link('/announcements.html', 'Announcements', ['/announcements.html']),
        link('/dashboard.html', 'Dashboard', ['/dashboard.html']),
        link('/events.html', 'Events', ['/events.html', '/event-details.html', '/event-request.html', '/my-registrations.html', '/my-applications.html']),
        link('/my-tickets.html', 'Tickets', ['/my-tickets.html']),
        link('/clubs.html', 'Clubs', ['/clubs.html', '/club-details.html', '/club-application.html', '/my-clubs.html']),
        link('/achievements.html', 'Achievements', ['/achievements.html', '/achievement-details.html']),
        link('/complaints.html', 'Complaints', ['/complaints.html', '/complaint-details.html']),
        link(Auth.dashboardFor(user.role), user.role === 'STUDENT' ? 'My Space' : 'Workspace',
          ['/admin/', '/organizer/', '/coordinator/', '/faculty/']),
      ].join('');
    } else {
      links = [
        link('/', 'Home', ['/']),
        link('/feed.html', 'Feed', ['/feed.html']),
        link('/events.html', 'Events', ['/events.html', '/event-details.html']),
        link('/clubs.html', 'Clubs', ['/clubs.html', '/club-details.html']),
        link('/achievements.html', 'Achievements', ['/achievements.html', '/achievement-details.html']),
        link('/announcements.html', 'Announcements', ['/announcements.html']),
      ].join('');
    }
    mount.className = 'topnav';
    mount.innerHTML = `
      <div class="topnav-inner">
        <a class="brand" href="/"><span class="brand-mark">CC</span> CollegeConnect</a>
        <button class="menu-toggle" aria-label="Toggle menu">Menu</button>
        <div class="nav-right">
          <div class="nav-links">${links}</div>
          ${user ? `
            <button class="theme-toggle" title="Toggle dark mode" aria-label="Toggle dark mode">🌙</button>
            <button class="notif-bell" type="button" data-notif-bell title="Notifications" aria-label="Notifications">&#128276;<span class="badge-dot" id="notif-count" style="display:none">0</span></button>
            <div class="nav-user"><b>${UI.esc(user.full_name)}</b>${UI.esc(UI.categoryLabel(user.role))}</div>
            <a class="btn btn-secondary btn-sm" href="/profile.html">Profile</a>
            <button class="btn btn-secondary btn-sm" id="logout-btn">Logout</button>
          ` : `
            <button class="theme-toggle" title="Toggle dark mode" aria-label="Toggle dark mode">🌙</button>
            <a class="btn btn-secondary btn-sm" href="/login.html">Login</a>
            <a class="btn btn-sm" href="/register.html">Register</a>
          `}
        </div>
      </div>`;

    const toggle = mount.querySelector('.menu-toggle');
    const linksEl = mount.querySelector('.nav-links');
    if (toggle && linksEl) toggle.addEventListener('click', () => linksEl.classList.toggle('open'));
    UI.theme.apply(UI.theme.get());

    const logoutBtn = mount.querySelector('#logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => {
        Auth.logout();
        location.href = '/login.html';
      });
    }

    UI.theme.apply(UI.theme.get()); // pages without #app-nav still get the toggle working

  // Notification bell opens the interactive panel; the badge polls the count.
  document.addEventListener('click', (e) => {
    const bell = e.target.closest('[data-notif-bell]');
    if (!bell) return;
    e.preventDefault();
    if (!Auth.user()) { location.href = '/login.html?next=%2Ffeed.html'; return; }
    // `Social` is declared with const in social.js, so it lives on the global
    // lexical scope rather than on window — guard with typeof, not window.Social.
    if (typeof Social !== 'undefined' && Social.openNotifPanel) Social.openNotifPanel(bell);
  });
  UI.refreshNotifBadge();
  setInterval(UI.refreshNotifBadge, 60000);

  }

  const foot = document.getElementById('app-footer');
  if (foot) {
    foot.className = 'site-footer';
    foot.innerHTML = `
      <div class="site-footer-inner">
        <div>CollegeConnect - One Platform for Your Campus</div>
        <div><a href="/terms.html">Terms &amp; Conditions</a> &middot; <a href="/privacy.html">Privacy Policy</a> &middot; <a href="/api/health">API Status</a></div>
      </div>`;
  }
});

/* ===================================================================== */
/* Achievements: shared icons, medal helper, gallery modal, card renderer  */
/* ===================================================================== */

UI.ACH_ICONS = {
  TECHNICAL: '\uD83D\uDCBB', SPORTS: '\uD83C\uDFC6', CULTURAL: '\uD83C\uDFAD', ACADEMIC: '\uD83C\uDF93',
  HACKATHON: '\uD83D\uDCBB', INNOVATION: '\uD83D\uDCA1', RESEARCH: '\uD83D\uDD2C',
  LEADERSHIP: '\uD83C\uDF96', SOCIAL_SERVICE: '\uD83E\uDD1D', OTHER: '\uD83C\uDF10',
};

/** Medal emoji for a placement, or empty string. */
UI.medalFor = function (position) {
  return { '1ST_PLACE': '\uD83E\uDD47', '2ND_PLACE': '\uD83E\uDD48', '3RD_PLACE': '\uD83E\uDD49',
    WINNER: '\uD83C\uDFC6' }[position] || '';
};

/**
 * Responsive photo gallery modal.
 * opts: { photos:[{file_path}], title, subtitle, positionText, startIndex }
 * Keyboard: Esc closes, ArrowLeft/Right navigate. Returns a close() fn.
 */
UI.openGallery = function ({ photos = [], title = '', subtitle = '', positionText = '', startIndex = 0 } = {}) {
  const items = photos.filter((p) => p && p.file_path);
  if (!items.length) { UI.toast('No photos to view yet', 'info'); return () => {}; }
  let i = Math.min(Math.max(0, startIndex | 0), items.length - 1);

  const overlay = document.createElement('div');
  overlay.className = 'gallery-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', (title ? title + ' ' : '') + 'photo gallery');
  overlay.innerHTML = `
    <div class="gallery-box">
      <button class="gallery-close" aria-label="Close gallery">&#10005;</button>
      <div class="gallery-stage">
        <button class="gallery-nav gallery-prev" aria-label="Previous photo" ${items.length < 2 ? 'style="display:none"' : ''}>&#10094;</button>
        <img alt="${UI.esc(title || 'Achievement photo')}" src="${UI.esc(items[i].file_path)}">
        <button class="gallery-nav gallery-next" aria-label="Next photo" ${items.length < 2 ? 'style="display:none"' : ''}>&#10095;</button>
      </div>
      <div class="gallery-caption">
        <div class="g-title"></div>
        <div class="g-sub"></div>
        <div class="g-pos"></div>
        ${items.length > 1 ? '<div class="gallery-dots"></div>' : ''}
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const img = overlay.querySelector('img');
  const dotsEl = overlay.querySelector('.gallery-dots');

  function render() {
    img.src = items[i].file_path;
    overlay.querySelector('.g-title').textContent = title || '';
    const sub = [];
    if (subtitle) sub.push(subtitle);
    sub.push(`Photo ${i + 1} of ${items.length}`);
    overlay.querySelector('.g-sub').textContent = sub.join(' \u00b7 ');
    const posEl = overlay.querySelector('.g-pos');
    posEl.textContent = positionText || '';
    if (dotsEl) {
      dotsEl.innerHTML = items.map((_p, idx) =>
        `<button class="dot ${idx === i ? 'active' : ''}" data-i="${idx}" aria-label="Go to photo ${idx + 1}"></button>`).join('');
      dotsEl.querySelectorAll('.dot').forEach((d) =>
        d.addEventListener('click', () => { i = +d.dataset.i; render(); }));
    }
  }
  const nav = (d) => { i = (i + d + items.length) % items.length; render(); };
  const close = () => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  };
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (items.length > 1 && e.key === 'ArrowLeft') nav(-1);
    else if (items.length > 1 && e.key === 'ArrowRight') nav(1);
  }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.gallery-close').addEventListener('click', close);
  const prev = overlay.querySelector('.gallery-prev');
  const next = overlay.querySelector('.gallery-next');
  if (prev) prev.addEventListener('click', () => nav(-1));
  if (next) next.addEventListener('click', () => nav(1));

  render();
  return close;
};

/**
 * Fetch an achievement's photos (from the public detail endpoint) and open
 * the gallery. Used by the "View Photos" button and by clicking a card image.
 */
UI.viewAchievementPhotos = async function (id, { title = '', subtitle = '', positionText = '', startIndex = 0 } = {}) {
  try {
    const res = await API.get(`/achievements/${id}`);
    const a = res.data || {};
    const photos = (a.media || []).filter((m) => m.file_type !== 'CERTIFICATE' && !/\.pdf$/i.test(m.file_path));
    if (!photos.length) { UI.toast('No photos uploaded yet', 'info'); return; }
    UI.openGallery({
      photos,
      title: title || a.title,
      subtitle: subtitle || a.team_name || a.winner_names || '',
      positionText: positionText || UI.positionLabel(a.position),
      startIndex,
    });
  } catch (e) {
    UI.toast(e.message, 'error');
  }
};

/** Render one achievement card for the Hall of Fame grid. */
UI.achievementCard = function (a, opts = {}) {
  const cat = UI.categoryLabel(a.category);
  const icon = UI.ACH_ICONS[a.category] || UI.ACH_ICONS.OTHER;
  const medal = UI.medalFor(a.position);
  const photoCount = Number(a.photo_count || 0);
  const hasPhoto = !!a.thumbnail_path;
  const winnerLine = [a.team_name, a.winner_names].filter(Boolean).join(' \u00b7 ');
  const positionText = UI.positionLabel(a.position);
  const certificatePath = (typeof a.certificate_path === 'string' && a.certificate_path.trim())
    ? a.certificate_path.trim()
    : ((typeof a.cert_path === 'string' && a.cert_path.trim()) ? a.cert_path.trim() : null);

  const mediaInner = hasPhoto
    ? `<img src="${UI.esc(a.thumbnail_path)}" alt="${UI.esc(a.title)}" loading="lazy">`
    : `<div class="ach-ph">
         <span class="ph-icon">${icon}</span>
         <span class="ph-cat">${UI.esc(cat)}</span>
         ${medal ? `<span class="ph-icon">${medal}</span>` : ''}
       </div>`;

  const countPill = photoCount > 0
    ? `<span class="ach-count">&#128247; ${photoCount}${photoCount > 1 ? ' photos' : ''}</span>` : '';
  const medalBadge = medal && hasPhoto ? `<span class="ach-medal">${medal}</span>` : '';

  // Actions: everyone can view; a "View Photos" button appears when photos exist.
  const viewPhotos = photoCount > 0
    ? `<button class="btn btn-sm" data-view-photos="${a.id}">View Photos</button>` : '';
  const details = `<a class="btn btn-sm btn-secondary" href="/achievement-details.html?id=${a.id}">Details</a>`;
  const extra = opts.extraActions ? opts.extraActions(a) : '';

  return `
    <div class="ach-card" data-ach-card="${a.id}">
      <div class="ach-media" data-open-gallery="${a.id}" role="button" tabindex="0"
           aria-label="View photos for ${UI.esc(a.title)}">
        ${mediaInner}${countPill}${medalBadge}
      </div>
      <div class="ach-body">
        <a class="ach-title" href="/achievement-details.html?id=${a.id}">${UI.esc(a.title)}</a>
        ${winnerLine ? `<div class="ach-winners"><span class="w-ico">&#127942;</span>${UI.esc(winnerLine)}</div>` : ''}
        <div class="ach-comp">
          <span class="ach-pos">${UI.esc(positionText)}</span>
          ${a.competition_name ? `<span class="ach-con">${UI.esc(a.competition_name)}</span>` : ''}
          <span class="ach-when">${a.event_date ? UI.fmtDate(a.event_date) : (a.achievement_year || '')}</span>
        </div>
        <div class="ach-meta">
          ${UI.statusBadge(a.category)}
          <span class="badge badge-gray">${a.achievement_year}</span>
          ${UI.statusBadge(a.verification_status)}
        </div>
        ${a.description ? `<div class="ach-desc">${UI.esc(a.description)}</div>` : ''}
        <div class="ach-actions">${viewPhotos}${certificatePath ? `<a class="btn btn-sm btn-secondary" href="${UI.esc(certificatePath)}" target="_blank" rel="noopener">Certificate</a>` : ''}${details}${extra}</div>
      </div>
      <div class="card-actions">
        ${extra}
        ${opts.extraActions ? '' : `<button class="btn btn-sm btn-secondary card-action-btn" data-action="view">View Details</button>`}
      </div>
    </div>`;
};

/** Wire up the interactive parts of achievement cards inside a container. */
UI.bindAchievementCards = function (container, aMap, opts = {}) {
  container.querySelectorAll('[data-open-gallery]').forEach((el) => {
    const open = () => {
      const id = +el.getAttribute('data-open-gallery');
      const a = (aMap && aMap[id]) || {};
      UI.viewAchievementPhotos(id, { title: a.title, subtitle: a.team_name || a.winner_names || '',
        positionText: UI.positionLabel(a.position) });
    };
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
  container.querySelectorAll('[data-view-photos]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = +btn.getAttribute('data-view-photos');
      const a = (aMap && aMap[id]) || {};
      UI.viewAchievementPhotos(id, { title: a.title, subtitle: a.team_name || a.winner_names || '',
        positionText: UI.positionLabel(a.position) });
    });
  });
};

/**
 * Reusable photo picker: validates image type + size, shows thumbnails with
 * remove buttons, and exposes the currently-valid files.
 * Returns { getFiles(): File[], reset() }.
 * opts: { max = 4, maxMB = 5, multiple = true }
 */
/**
 * File picker for non-image uploads (certificate / proof PDF).
 * Validates type + size, previews a text link, and exposes the currently-valid
 * files. Returns { getFiles(): File[], reset() }.
 * opts: { accept = '', maxMB = 5 }
 */
UI.bindFilePicker = function(inputEl, hintEl, opts) {
  opts = opts || {};
  var allowed = opts.accept || '';
  var maxMB = opts.maxMB || 5;
  var files = [];

  function render() {
    if (hintEl) {
      hintEl.className = 'upload-hint';
      hintEl.textContent = files.length ? files.length + ' file(s) selected' : '';
    }
  }

  function warn(msg) {
    if (hintEl) { hintEl.className = 'upload-hint err'; hintEl.textContent = msg; }
    UI.toast(msg, 'error');
  }

  if (inputEl) {
    inputEl.addEventListener('change', function() {
      var picked = Array.prototype.slice.call(inputEl.files || []);
      for (var i = 0; i < picked.length; i++) {
        var f = picked[i];
        if (allowed) {
          var ok = false;
          var name = f.name.toLowerCase();
          var parts = allowed.toLowerCase().split(',');
          for (var j = 0; j < parts.length; j++) {
            if (name.indexOf(parts[j]) !== -1) { ok = true; break; }
          }
          if (!ok) { warn('"' + f.name + '" is not an allowed file type.'); continue; }
        }
        if (f.size > maxMB * 1024 * 1024) {
          warn('"' + f.name + '" is larger than ' + maxMB + ' MB.');
          continue;
        }
        files.push(f);
      }
      inputEl.value = '';
      render();
    });
  }
  render();
  return {
    getFiles: function() { return files.slice(); },
    reset: function() { files = []; render(); }
  };
};
UI.bindPhotoPicker = function (inputEl, previewEl, hintEl, opts = {}) {
  const max = opts.max || 4;
  const maxMB = opts.maxMB || 5;
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  let files = [];

  function render() {
    if (!previewEl) return;
    previewEl.innerHTML = files.map((f, i) => `
      <div class="up-thumb">
        <img alt="${UI.esc(f.name)}" src="${URL.createObjectURL(f)}">
        <button type="button" class="up-rm" data-i="${i}" aria-label="Remove photo">&#10005;</button>
      </div>`).join('');
    previewEl.querySelectorAll('.up-rm').forEach((b) =>
      b.addEventListener('click', () => { files.splice(+b.dataset.i, 1); render(); }));
    if (hintEl) {
      hintEl.className = 'upload-hint';
      hintEl.textContent = files.length ? `${files.length} photo(s) selected` : '';
    }
  }

  function warn(msg) {
    if (hintEl) { hintEl.className = 'upload-hint err'; hintEl.textContent = msg; }
    UI.toast(msg, 'error');
  }

  if (inputEl) {
    inputEl.addEventListener('change', () => {
      const picked = Array.from(inputEl.files || []);
      for (const f of picked) {
        if (!allowed.includes(f.type)) { warn(`"${f.name}" is not a supported image (use JPEG, PNG, WebP or GIF).`); continue; }
        if (f.size > maxMB * 1024 * 1024) { warn(`"${f.name}" is larger than ${maxMB} MB.`); continue; }
        if (files.length >= max) { warn(`You can upload at most ${max} photos.`); break; }
        files.push(f);
      }
      inputEl.value = '';
      render();
    });
  }
  render();
  return { getFiles: () => files.slice(), reset: () => { files = []; render(); } };
};
