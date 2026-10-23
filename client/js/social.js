'use strict';
/* ============================================================
   Social shared components: post cards, comments, polls,
   sidebar + mobile tabbar. Requires api.js and ui.js first.
   ============================================================ */  /** Replay a one-shot CSS animation class (forces a reflow so it can restart). */
function playOnce(el, cls = 'bump') {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}


const Social = {
  /** Autolink #hashtags inside post text (input must be escaped). */
  linkHashtags(escapedText) {
    return escapedText.replace(/(^|\s)#([A-Za-z][A-Za-z0-9_]{1,28})/g,
      (_m, sp, tag) => `${sp}<a class="hashtag" href="/search.html?q=%23${tag.toLowerCase()}">#${tag}</a>`);
  },
  /** Render sidebar + mobile tabbar; pass nav override entries if needed. */
  chrome(active) {
    const user = Auth.user();
    const navItems = [
      ['/feed.html', '&#127968;', 'Home'],
      ['/search.html', '&#128269;', 'Explore'],
      ['/communities.html', '&#128101;', 'Communities'],
      ['/events.html', '&#128197;', 'Events'],
      ['/clubs.html', '&#127942;', 'Clubs'],
      ['/notifications.html', '&#128276;', 'Notifications', true],
      ['/saved.html', '&#128278;', 'Saved'],
      ['/announcements.html', '&#128227;', 'Announcements'],
      ['/achievements.html', '&#127941;', 'Achievements'],
      ['/complaints.html', '&#128221;', 'Complaints'],
      [Auth.dashboardFor(user ? user.role : 'STUDENT'), '&#128736;&#65039;', user && user.role !== 'STUDENT' ? 'Workspace' : 'Dashboard'],
    ];
    if (user) navItems.push(['/profile.html', '&#128100;', 'My Profile']);
    const snav = document.getElementById('snav');
    if (snav) {
      // Profile summary (left rail): avatar, name, role. Links still below.
      const summary = user ? `
        <a class="snav-profile" href="/profile.html">
          ${user.avatar_path ? `<img class="post-avatar avatar-sm" src="${UI.esc(user.avatar_path)}" alt="">`
            : `<span class="post-avatar avatar-sm">${UI.esc((user.full_name || '?').charAt(0).toUpperCase())}</span>`}
          <span class="sp-text">
            <b>${UI.esc(user.full_name)}</b>
            <span class="pb-sub">${UI.esc(UI.categoryLabel(user.role))}</span>
          </span>
        </a>` : `<a class="snav-profile" href="/login.html?next=${encodeURIComponent(active || '/feed.html')}">
          <span class="post-avatar avatar-sm">?</span>
          <span class="sp-text"><b>Guest</b><span class="pb-sub">Log in to join in</span></span>
        </a>`;
      snav.innerHTML = summary + '<nav class="snav-links">' + navItems.map(([href, ic, label, badge]) =>
        `<a href="${href}"${active === href ? ' class="active"' : ''}><span class="sn-ic">${ic}</span>${label}${
          badge ? '<span class="sn-badge" data-notif-badge style="display:none">0</span>' : ''}</a>`).join('') + '</nav>';
      UI.refreshNotifBadge();
    }
    const mobileItems = [
      ['/feed.html', '&#127968;', 'Home', 'Home'],
      ['/search.html', '&#128269;', 'Explore', 'Explore and search campus'],
      ['#create', '&#10133;', 'Create', 'Create post'],
      ['/notifications.html', '&#128276;', 'Alerts', 'Notifications'],
      [user ? '/profile.html' : '/login.html', '&#128100;', user ? 'Profile' : 'Login', user ? 'My profile' : 'Log in'],
    ];
    const tabbar = document.getElementById('tabbar');
    if (tabbar) {
      tabbar.innerHTML = mobileItems.map(([href, ic, label, aria]) =>
        `<a href="${href}" aria-label="${aria}" class="${href === '#create' ? 'create-btn' : ''}${active === href ? ' active' : ''}"><span class="mt-ic">${ic}</span>${label}</a>`).join('');
      const create = tabbar.querySelector('.create-btn');
      if (create) create.addEventListener('click', (e) => {
        if (create.getAttribute('href') === '#create') {
          e.preventDefault();
          if (!Auth.user()) { location.href = '/login.html?next=%2Ffeed.html'; return; }
          // Pages that own a composer can take over with an animated create menu.
          if (typeof this._onCreate === 'function') { this._onCreate(); return; }
          const t = document.getElementById('post-text');
          if (t) { t.focus(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
        }
      });
    }
  },

  avatar(p, cls = '') {
    if (p.author_avatar) return `<img class="post-avatar ${cls}" src="${UI.esc(p.author_avatar)}" alt="">`;
    return `<span class="post-avatar ${cls}">${UI.esc((p.author_name || '?').charAt(0).toUpperCase())}</span>`;
  },

  byline(p) {
    // Privacy: internal student IDs are never shown on public posts or profiles.
    const sub = p.is_anonymous
      ? 'Anonymous Student'
      : [p.author_dept, p.author_year ? `Year ${p.author_year}` : ''].filter(Boolean).join(' · ');
    // Verified institutional (college / club) accounts get a check badge + Official chip;
    // anonymous posts never carry either, so no identity signal leaks.
    const isOfficial = !p.is_anonymous && p.author_verified && p.author_account_type && p.author_account_type !== 'student';
    const verifiedBadge = isOfficial
      ? `<span class="vbadge" title="Verified ${UI.esc(UI.categoryLabel(p.author_account_type))} account">&#10003;</span>` : '';
    const officialChip = isOfficial ? `<span class="official-chip">Official</span>` : '';
    const name = p.is_anonymous
      ? `<span class="pb-name"><span class="anon-dot" aria-hidden="true">A</span>Anonymous Student</span>`
      : `<a class="pb-name" href="/profile.html?id=${p.author_id}">${UI.esc(p.author_name)}${verifiedBadge}</a>`;
    const comm = p.community_name ? ` in <a href="/community.html?slug=${UI.esc(p.community_slug)}">${UI.esc(p.community_name)}</a>` : '';
    return `
      ${this.avatar(p)}
      <div class="post-byline">
        <div class="pb-name-row">${name}${officialChip}</div>
        <div class="pb-sub">${sub}${sub ? ' · ' : ''}${UI.timeAgo(p.created_at)}${comm}</div>
      </div>`;
  },

  poll(p) {
    const poll = p.poll;
    if (!poll) return '';
    const revealed = poll.revealed;
    const opts = poll.options.map((o) => `
      <button type="button" class="poll-opt ${poll.my_vote === o.id ? 'mine' : ''} ${revealed ? 'revealed' : ''}" data-option="${o.id}">
        <span class="po-fill" style="${revealed ? `width:${o.pct}%` : 'width:0'}"></span>
        <span class="po-inner">
          <span class="po-check">${poll.my_vote === o.id ? '&#10003;' : ''}</span>
          <span>${UI.esc(o.label)}</span>
          <span class="po-pct">${revealed ? `${o.pct}%` : ''}</span>
        </span>
      </button>`).join('');
    return `
      <div class="poll-block" data-poll-post="${p.id}">
        <div class="poll-q">&#128202; ${UI.esc(poll.question)}</div>
        ${opts}
        <div class="poll-meta">${poll.total_votes} vote${poll.total_votes === 1 ? '' : 's'}${revealed ? '' : ' · vote to see results'}</div>
      </div>`;
  },

  body(p) {
    const kindChip = p.kind === 'QUESTION' ? '<span class="post-qchip">&#10067; Question</span>' : '';
    const media = p.image_path
      ? `<div class="post-media"><img src="${UI.esc(p.image_path)}" alt="Post image" loading="lazy"></div>`
      : (p.video_path ? `<div class="post-media"><video src="${UI.esc(p.video_path)}" controls preload="metadata"></video></div>` : '');
    return `
      <div class="post-body">
        ${kindChip}
        ${p.title ? `<div class="post-title">${UI.esc(p.title)}</div>` : ''}
        <div class="post-content">${this.linkHashtags(UI.esc(p.content))}</div>
        ${media}
        ${this.poll(p)}
      </div>`;
  },

  /** Upvote / downvote column shown on discussion (QUESTION) posts. */
  voteCol(p) {
    const score = Number(p.like_count || 0) - Number(p.dislike_count || 0);
    const mine = Number(p.my_reaction || 0);
    return `<div class="vote-col" title="Upvote or downvote this discussion">
      <button class="vote-btn up ${mine === 1 ? 'on' : ''}" data-vote="1" data-vote-post="${p.id}" aria-label="Upvote">&#9650;</button>
      <span class="post-score ${score > 0 ? 'pos' : score < 0 ? 'neg' : ''}" data-score="${p.id}">${score}</span>
      <button class="vote-btn down ${mine === -1 ? 'on' : ''}" data-vote="-1" data-vote-post="${p.id}" aria-label="Downvote">&#9660;</button>
    </div>`;
  },

  card(p, user, index = 0) {
    return Social.cardRaw(p, user, index).outerHTML;
  },

  /** Returns the card DOM node (used internally so callers can animate the element). */
  cardRaw(p, user, index = 0) {
    const mine = user && p.author_id === user.id;
    const staff = user && ['ADMIN', 'FACULTY'].includes(user.role);
    const editable = mine && p.kind !== 'POLL';
    const menu = (mine || staff) ? `
      <div class="post-menu">
        <button class="post-menu-btn" data-menu="${p.id}" aria-label="Post menu">&#8942;</button>
        <div class="post-menu-pop" data-pop="${p.id}">
          ${editable ? `<button data-edit="${p.id}">Edit post</button>` : ''}
          <button class="danger" data-del="${p.id}">Delete post</button>
          <button data-report="${p.id}">Report post</button>
        </div>
      </div>` : '';
    const el = document.createElement('article');
    el.className = 'card post-card reveal';
    el.dataset.post = p.id;
    el.style.setProperty('--d', `${Math.min(index, 7) * 55}ms`);
    el.innerHTML = `
        <div class="post-head">
          ${this.byline(p)}
          ${menu}
        </div>
        ${p.kind === 'QUESTION'
          ? `<div class="post-vote-row"><div style="min-width:0;flex:1">${this.body(p)}</div>${this.voteCol(p)}</div>`
          : this.body(p)}
        <div class="post-actions">
          <button class="pa-btn ${p.liked_by_me ? 'liked' : ''}" data-like="${p.id}" aria-pressed="${p.liked_by_me ? 'true' : 'false'}">
            <span class="pa-ic">${p.liked_by_me ? '&#10084;&#65039;' : '&#129293;'}</span> <span data-like-count>${p.like_count}</span><span class="pa-label">Like</span>
          </button>
          <button class="pa-btn" data-comments="${p.id}"><span class="pa-ic">&#128172;</span> <span data-c-count>${p.comment_count}</span><span class="pa-label">Comments</span></button>
          <button class="pa-btn" data-share="${p.id}"><span class="pa-ic">&#8599;&#65039;</span> <span class="pa-label">Share</span></button>
          <button class="pa-btn ${p.saved_by_me ? 'saved' : ''}" data-save="${p.id}"><span class="pa-ic">&#128278;</span> <span class="pa-label">${p.saved_by_me ? 'Saved' : 'Save'}</span></button>
        </div>
        <div class="comments-wrap" data-comments-wrap="${p.id}">
          <div class="comments-inner">
            <div data-comments-list></div>
            ${user ? `
            <form class="comment-form" data-comment-form="${p.id}">
              <input type="text" placeholder="Write a comment..." maxlength="1000">
              <button class="btn btn-sm" type="submit">Send</button>
            </form>` : '<div class="pb-sub" style="margin-top:8px"><a href="/login.html?next=%2Ffeed.html">Log in</a> to join the conversation.</div>'}
          </div>
        </div>
      `;
    return el;
  },

  renderComments(comments, loggedIn, viewer) {
    const mine = (c) => viewer && c.author_id != null && Number(c.author_id) === Number(viewer.id);
    const staff = viewer && ['ADMIN', 'FACULTY'].includes(viewer.role);
    const one = (c, isReply) => `
      <div class="comment-row" data-comment="${c.id}">
        <span class="post-avatar avatar-sm">${UI.esc((c.author_name || '?').charAt(0).toUpperCase())}</span>
        <div class="comment-bubble">
          <div class="cb-head">
            <b>${UI.esc(c.author_name)}</b>
            ${c.author_verified && c.author_account_type !== 'student' ? '<span class="vbadge" title="Verified">&#10003;</span>' : ''}
            <span class="cb-time">${UI.timeAgo(c.created_at)}</span>
            ${c.is_anonymous ? '<span class="cb-time">· anonymous</span>' : ''}
          </div>
          <div class="cb-text">${UI.esc(c.content)}</div>
          ${loggedIn && !isReply ? `<button type="button" class="reply-toggle" data-reply-to="${c.id}">Reply</button>` : ''}
          ${loggedIn && (mine(c) || staff) ? `
            <button type="button" class="reply-toggle" data-comment-edit="${c.id}">Edit</button>
            <button type="button" class="reply-toggle" data-comment-del="${c.id}" style="color:var(--danger)">Delete</button>` : ''}
          ${loggedIn && !(mine(c) || staff) ? `<button type="button" class="reply-toggle" data-report-comment="${c.id}" style="margin-left:auto;color:var(--danger);font-size:11.5px">Report</button>` : ''}
        </div>
      </div>`;
    return comments.map((c) => `${one(c, false)}${(c.replies || []).map((r) => one(r, true)).join('')}`).join('');
  },

  /* ==========================================================
     Motion helpers: reveal-on-scroll, double-tap like, tab pill
     ========================================================== */
  /** Reveal cards as they scroll into view (skipped for reduced motion). */
  revealFeed(container) {
    if (!container) return;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const nodes = container.querySelectorAll('.reveal:not(.in)');
    if (reduce || !('IntersectionObserver' in window)) {
      nodes.forEach((n) => n.classList.add('in'));
      return;
    }
    if (!this._io) {
      this._io = new IntersectionObserver((entries) => {
        entries.forEach((en) => {
          if (en.isIntersecting) { en.target.classList.add('in'); this._io.unobserve(en.target); }
        });
      }, { threshold: 0.01, rootMargin: '0px 0px -6% 0px' });
    }
    nodes.forEach((n) => this._io.observe(n));
    this.guardEntranceAnimations(container);
  },

  /**
   * Safety net: some embedded webviews never composite a frame, which leaves
   * CSS entrance animations parked on their "from" keyframe — in other words,
   * invisible content. Probe once and fall back to a static visible state.
   */
  guardEntranceAnimations(container) {
    if (this._entranceChecked) return;
    setTimeout(() => {
      if (this._entranceChecked) return;
      const probe = container.querySelector('.reveal.in');
      if (!probe) return;
      this._entranceChecked = true;
      if (getComputedStyle(probe).opacity === '0') document.documentElement.classList.add('no-entrance-anim');
    }, 1500);
  },

  /** Double-tap a post to like it, with the classic heart burst. */
  tapLike(card) {
    if (!card) return;
    const likeBtn = card.querySelector('[data-like]');
    if (likeBtn && !likeBtn.classList.contains('liked')) likeBtn.click();
    const host = card.querySelector('.post-media') || card.querySelector('.post-body') || card;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    const burst = document.createElement('div');
    burst.className = 'heart-burst';
    burst.setAttribute('aria-hidden', 'true');
    burst.innerHTML = '<span>&#10084;&#65039;</span>';
    host.appendChild(burst);
    setTimeout(() => burst.remove(), 950);
  },

  /**
   * Animated sliding pill behind a tab bar's active button.
   * Safe to call repeatedly: the click listener is bound once and the
   * selection callback can be swapped out. Returns { refresh }.
   */
  tabs(container, onSelect) {
    if (!container) return { refresh() {} };
    let ind = container.querySelector('.tab-ind');
    if (!ind) {
      ind = document.createElement('span');
      ind.className = 'tab-ind';
      ind.setAttribute('aria-hidden', 'true');
      container.prepend(ind);
    }
    if (onSelect) container._onTab = onSelect;
    const active = () => container.querySelector('button.active') || container.querySelector('button');
    const place = (btn, animate = true) => {
      if (!btn) return;
      if (!animate) ind.style.transition = 'none';
      const t = container.getBoundingClientRect();
      const b = btn.getBoundingClientRect();
      ind.style.width = `${b.width}px`;
      ind.style.transform = `translateX(${b.left - t.left - container.clientLeft}px)`;
      if (!animate) { void ind.offsetWidth; ind.style.transition = ''; }
    };
    const refresh = () => place(active(), false);
    if (container.dataset.tabsBound !== '1') {
      container.dataset.tabsBound = '1';
      container.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn || !container.contains(btn)) return;
        container.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
        place(btn);
        if (typeof container._onTab === 'function') container._onTab(btn);
      });
      window.addEventListener('resize', refresh);
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(refresh);
    }
    refresh();
    return { refresh };
  },

  /** Delegated interactions for a container of post cards. */
  bindInteractions(container, { onChange, afterSave } = {}) {
    if (!container) return;
    // Bind once per container: delegated listeners survive re-renders.
    if (container.dataset.socialBound === '1') return;
    container.dataset.socialBound = '1';
    this.revealFeed(container);
    // Fresh cards arrive on every feed load, so keep watching for reveals.
    if (window.MutationObserver) {
      new MutationObserver(() => this.revealFeed(container)).observe(container, { childList: true, subtree: true });
    }
    container.addEventListener('click', async (e) => {
      const card = e.target.closest('.post-card');
      if (!card) return;
      const postId = card.dataset.post;
      if (e.target.closest('[data-menu]')) {
        const pop = card.querySelector('.post-menu-pop');
        document.querySelectorAll('.post-menu-pop.open').forEach((p) => { if (p !== pop) p.classList.remove('open'); });
        pop.classList.toggle('open');
        return;
      }
      if (e.target.closest('[data-del]')) {
        const okd = await UI.confirm('Delete this post permanently?', { title: 'Delete post', confirmText: 'Delete' });
        if (!okd) return;
        try {
          await API.del(`/social/posts/${postId}`);
          card.remove();
          UI.toast('Post deleted', 'success');
          if (onChange) onChange();
        } catch (err) { UI.toast(err.message, 'error'); }
        return;
      }
      if (e.target.closest('[data-report]')) {
        if (!Auth.user()) { location.href = '/login.html?next=%2Ffeed.html'; return; }
        const reasonMap = {
          'Spam / repetitive content': 'SPAM',
          'Harassment / targeted abuse': 'HARASSMENT',
          'Hate speech / discrimination': 'HATE_SPEECH',
          'Violence / threats': 'VIOLENCE',
          'Misinformation': 'MISINFO',
          'Image shared without consent': 'NDA_IMG',
          'Other': 'OTHER',
        };
        const reason = await UI.pickOne('Why are you reporting this post?', Object.keys(reasonMap));
        if (!reason) return;
        try {
          await API.post('/reports/posts', { postId: Number(postId), reason: reasonMap[reason], detail: '' });
          UI.toast('Report submitted. Thanks for helping keep campus safe.', 'success');
          const pop = card.querySelector('.post-menu-pop');
          if (pop) pop.classList.remove('open');
        } catch (err) { UI.toast(err.message, 'error'); }
        return;
      }
      if (e.target.closest('[data-edit]')) {
        const pop = card.querySelector('.post-menu-pop');
        if (pop) pop.classList.remove('open');
        const contentEl = card.querySelector('.post-content');
        if (!contentEl || card.querySelector('.post-edit-box')) return;
        // Plain text snapshot (hashtags render as links; strip them back out).
        const current = contentEl.textContent;
        const box = document.createElement('div');
        box.className = 'post-edit-box';
        box.innerHTML = `
          <textarea maxlength="4000">${UI.esc(current)}</textarea>
          <div class="post-edit-actions">
            <button class="btn btn-sm btn-secondary" data-edit-cancel>Cancel</button>
            <button class="btn btn-sm" data-edit-save="${postId}">Save changes</button>
          </div>`;
        contentEl.style.display = 'none';
        contentEl.insertAdjacentElement('afterend', box);
        const ta = box.querySelector('textarea');
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        return;
      }
      if (e.target.closest('[data-edit-cancel]')) {
        const box = e.target.closest('.post-edit-box');
        const contentEl = card.querySelector('.post-content');
        box.remove();
        if (contentEl) contentEl.style.display = '';
        return;
      }
      if (e.target.closest('[data-edit-save]')) {
        const box = e.target.closest('.post-edit-box');
        const ta = box.querySelector('textarea');
        const text = ta.value.trim();
        if (!text) { UI.toast('Post content is required', 'error'); return; }
        const saveBtn = e.target.closest('[data-edit-save]');
        saveBtn.disabled = true;
        try {
          const res = await API.put(`/social/posts/${postId}`, { content: text });
          card.querySelector('.post-body').outerHTML = this.body(res.data);
          UI.toast('Post updated', 'success');
        } catch (err) { UI.toast(err.message, 'error'); saveBtn.disabled = false; }
        return;
      }
      if (e.target.closest('[data-comment-edit]')) {
        const row = e.target.closest('.comment-row');
        const bubble = row.querySelector('.comment-bubble');
        const textEl = bubble.querySelector('.cb-text');
        if (bubble.querySelector('.comment-edit-box')) return;
        const box = document.createElement('div');
        box.className = 'comment-edit-box';
        box.innerHTML = `
          <textarea maxlength="1000">${UI.esc(textEl.textContent)}</textarea>
          <div class="post-edit-actions">
            <button class="btn btn-sm btn-secondary" data-comment-cancel>Cancel</button>
            <button class="btn btn-sm" data-comment-save="${row.dataset.comment}">Save</button>
          </div>`;
        textEl.style.display = 'none';
        textEl.insertAdjacentElement('afterend', box);
        box.querySelector('textarea').focus();
        return;
      }
      if (e.target.closest('[data-comment-cancel]')) {
        const box = e.target.closest('.comment-edit-box');
        const textEl = box.closest('.comment-bubble').querySelector('.cb-text');
        box.remove();
        if (textEl) textEl.style.display = '';
        return;
      }
      if (e.target.closest('[data-comment-save]')) {
        const btn = e.target.closest('[data-comment-save]');
        const box = e.target.closest('.comment-edit-box');
        const cid = btn.dataset.commentSave;
        const text = box.querySelector('textarea').value.trim();
        if (!text) { UI.toast('Comment cannot be empty', 'error'); return; }
        btn.disabled = true;
        try {
          await API.put(`/social/posts/${postId}/comments/${cid}`, { content: text });
          const textEl = box.closest('.comment-bubble').querySelector('.cb-text');
          textEl.textContent = text;
          textEl.style.display = '';
          box.remove();
          UI.toast('Comment updated', 'success');
        } catch (err) { UI.toast(err.message, 'error'); btn.disabled = false; }
        return;
      }
      if (e.target.closest('[data-comment-del]')) {
        const btn = e.target.closest('[data-comment-del]');
        const cid = btn.dataset.commentDel;
        if (!(await UI.confirm('Delete this comment? Replies to it are removed too.', { title: 'Delete comment', confirmText: 'Delete' }))) return;
        try {
          await API.del(`/social/posts/${postId}/comments/${cid}`);
          const row = btn.closest('.comment-row');
          row.remove();
          const cnt = card.querySelector('[data-c-count]');
          if (cnt) cnt.textContent = Math.max(0, Number(cnt.textContent) - 1);
          UI.toast('Comment deleted', 'success');
        } catch (err) { UI.toast(err.message, 'error'); }
        return;
  }
      const voteBtn = e.target.closest('[data-vote]');
      if (voteBtn) {
        if (!Auth.user()) { location.href = '/login.html?next=%2Ffeed.html'; return; }
        try {
          const value = Number(voteBtn.dataset.vote);
          const res = await API.put('/social/reactions', { target_type: 'POST', target_id: Number(postId), value });
          const scoreEl = card.querySelector('[data-score]');
          const arrows = card.querySelectorAll('[data-vote]');
          const counts = res.data.counts || {};
          const score = Number(counts.likes || 0) - Number(counts.dislikes || 0);
          scoreEl.textContent = score;
          scoreEl.classList.toggle('pos', score > 0);
          scoreEl.classList.toggle('neg', score < 0);
          arrows.forEach((a) => a.classList.remove('on'));
          if (res.data.reacted) voteBtn.classList.add('on');
          const likeCount = card.querySelector('[data-like-count]');
          if (likeCount && counts.likes != null) likeCount.textContent = counts.likes;
          const likeBtn2 = card.querySelector('[data-like]');
          if (likeBtn2) {
            const liked = Number(res.data.my_reaction) === 1;
            likeBtn2.classList.toggle('liked', liked);
            likeBtn2.setAttribute('aria-pressed', liked ? 'true' : 'false');
            const ic2 = likeBtn2.querySelector('.pa-ic');
            if (ic2) ic2.innerHTML = liked ? '&#10084;&#65039;' : '&#129293;';
            if (liked) playOnce(likeBtn2, 'bump');
          }
        } catch (err) { UI.toast(err.message, 'error'); }
        return;
      }
      const likeBtn = e.target.closest('[data-like]');
      if (likeBtn) {
        if (!Auth.user()) { location.href = '/login.html?next=%2Ffeed.html'; return; }
        try {
          const res = await API.put('/social/reactions', { target_type: 'POST', target_id: Number(postId), value: 1 });
          likeBtn.classList.toggle('liked', res.data.reacted);
          likeBtn.setAttribute('aria-pressed', res.data.reacted ? 'true' : 'false');
          const countSpan = likeBtn.querySelector('[data-like-count]');
          if (countSpan) countSpan.textContent = Number(countSpan.textContent) + (res.data.reacted ? 1 : -1);
          const likeIc = likeBtn.querySelector('.pa-ic');
          if (likeIc) likeIc.innerHTML = res.data.reacted ? '&#10084;&#65039;' : '&#129293;';
          if (res.data.reacted) playOnce(likeBtn, 'bump');
          // Keep the discussion score in sync when a vote column is present.
          const scoreEl2 = card.querySelector('[data-score]');
          const counts2 = res.data.counts || {};
          if (scoreEl2 && counts2.likes != null) {
            const score2 = Number(counts2.likes) - Number(counts2.dislikes || 0);
            scoreEl2.textContent = score2;
            scoreEl2.classList.toggle('pos', score2 > 0);
            scoreEl2.classList.toggle('neg', score2 < 0);
            const mr = counts2.my_reaction != null ? counts2.my_reaction : res.data.my_reaction;
            card.querySelectorAll('[data-vote]').forEach((a) => a.classList.toggle('on', Number(mr) === Number(a.dataset.vote)));
          }
        } catch (err) { UI.toast(err.message, 'error'); }
        return;
      }
      const saveBtn = e.target.closest('[data-save]');
      if (saveBtn) {
        if (!Auth.user()) { location.href = '/login.html?next=%2Ffeed.html'; return; }
        try {
          const res = await API.put(`/social/posts/${postId}/save`);
          saveBtn.classList.toggle('saved', res.data.saved);
          saveBtn.querySelector('.pa-label').textContent = res.data.saved ? 'Saved' : 'Save';
          saveBtn.setAttribute('aria-pressed', res.data.saved ? 'true' : 'false');
          if (res.data.saved) playOnce(saveBtn, 'bump');
          UI.toast(res.message, 'success');
          if (afterSave) afterSave(res.data.saved, card);
        } catch (err) { UI.toast(err.message, 'error'); }
        return;
      }
      const opt = e.target.closest('.poll-opt');
      if (opt && opt.closest('[data-poll-post]')) {
        if (!Auth.user()) { location.href = '/login.html?next=%2Ffeed.html'; return; }
        if (!opt.closest('.poll-block').classList.contains('revealed')) {
          try {
            const res = await API.put(`/social/posts/${postId}/poll`, { option_id: Number(opt.dataset.option) });
            card.querySelector('.post-body').outerHTML = this.body(res.data);
            UI.toast('Vote recorded', 'success');
          } catch (err) { UI.toast(err.message, 'error'); }
        } else {
          UI.toast('You already voted — tap another option to change your vote', 'info');
        }
        return;
      }
      if (e.target.closest('[data-comments]')) {
        const wrap = card.querySelector('[data-comments-wrap]');
        const cBtn = e.target.closest('[data-comments]');
        if (wrap.classList.contains('open')) { wrap.classList.remove('open'); cBtn.classList.remove('commented'); return; }
        await this.openComments(postId, wrap);
        cBtn.classList.add('commented');
        return;
      }
      const replyBtn = e.target.closest('[data-reply-to]');
      if (replyBtn) {
        const input = card.querySelector('[data-comment-form] input');
        input.value = `@replying to #${replyBtn.dataset.replyTo}: `;
        input.focus();
        return;
      }
      const commentReportBtn = e.target.closest('[data-report-comment]');
      if (commentReportBtn) {
        if (!Auth.user()) { location.href = '/login.html?next=%2Ffeed.html'; return; }
        const reasonMap = {
          'Spam / repetitive content': 'SPAM',
          'Harassment / targeted abuse': 'HARASSMENT',
          'Hate speech / discrimination': 'HATE_SPEECH',
          'Violence / threats': 'VIOLENCE',
          'Misinformation': 'MISINFO',
          'Other': 'OTHER',
        };
        const reason = await UI.pickOne('Why are you reporting this comment?', Object.keys(reasonMap));
        if (!reason) return;
        // Find the comment id from the button's data attribute.
        const commentId = Number(commentReportBtn.dataset.reportComment);
        try {
          await API.post('/reports/comments', { commentId, reason: reasonMap[reason], detail: '' });
          UI.toast('Report submitted. Thanks for helping keep campus safe.', 'success');
        } catch (err) { UI.toast(err.message, 'error'); }
        return;
      }
      if (e.target.closest('[data-share]')) {
        this.openShare(e.target.closest('[data-share]'), postId);
      }
    });

    container.addEventListener('submit', async (e) => {
      const form = e.target.closest('[data-comment-form]');
      if (!form) return;
      e.preventDefault();
      if (!Auth.user()) { location.href = '/login.html?next=%2Ffeed.html'; return; }
      const postId = form.dataset.commentForm;
      const input = form.querySelector('input');
      const text = input.value.trim();
      if (!text) return;
      try {
        const res = await API.post(`/social/posts/${postId}/comments`, { content: text });
        form.closest('[data-comments-wrap]').querySelector('[data-comments-list]')
          .innerHTML = this.renderComments(res.data.comments, true, Auth.user());
        input.value = '';
        const cnt = form.closest('.post-card').querySelector('[data-c-count]');
        cnt.textContent = Number(cnt.textContent) + 1;
        UI.toast('Comment added', 'success');
      } catch (err) { UI.toast(err.message, 'error'); }
    });

    // Desktop double-click and mobile double-tap both mean "like this".
    container.addEventListener('dblclick', (e) => {
      const card = e.target.closest('.post-card');
      if (!card) return;
      if (e.target.closest('.pa-btn, .poll-opt, .vote-btn, .comments-wrap, .post-menu, video, a, input, button')) return;
      this.tapLike(card);
    });
    let lastTap = 0;
    let lastCard = null;
    container.addEventListener('touchend', (e) => {
      const card = e.target.closest('.post-card');
      if (!card || e.target.closest('.pa-btn, .poll-opt, .vote-btn, .comments-wrap, .post-menu, video, a, input, button')) {
        lastTap = 0;
        lastCard = null;
        return;
      }
      const now = Date.now();
      if (now - lastTap < 320 && lastCard === card) { lastTap = 0; lastCard = null; this.tapLike(card); }
      else { lastTap = now; lastCard = card; }
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.post-menu')) document.querySelectorAll('.post-menu-pop.open').forEach((p) => p.classList.remove('open'));
    });
  },

  /* ==========================================================
     Notifications panel (topnav bell)
     ========================================================== */
  notifIcon(type) {
    return {
      SOCIAL: '&#128172;', EVENT: '&#128197;', ANNOUNCEMENT: '&#128227;',
      ACHIEVEMENT: '&#127942;', COMPLAINT: '&#128221;', VERIFICATION: '&#9989;',
      SYSTEM: '&#9881;&#65039;', GENERAL: '&#128276;',
    }[type] || '&#128276;';
  },

  async openNotifPanel(anchor) {
    let panel = document.getElementById('notif-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'notif-panel';
      panel.className = 'notif-panel';
      document.body.appendChild(panel);
      document.addEventListener('click', (e) => {
        if (!e.target.closest('#notif-panel') && !e.target.closest('[data-notif-bell]')) {
          document.querySelectorAll('#notif-panel.open').forEach((p) => p.classList.remove('open'));
        }
      });
    }
    if (panel.classList.contains('open') && !panel.dataset.loading) {
      panel.classList.remove('open');
      return;
    }
    panel.innerHTML = '<div style="padding:18px"><div class="skeleton w40"></div><div class="skeleton w80"></div><div class="skeleton w60"></div></div>';
    panel.classList.add('open');
    try {
      const res = await API.get('/notifications');
      const rows = res.data || [];
      panel.innerHTML = `
        <div class="notif-panel-head">
          <h3>Notifications</h3>
          <div style="display:flex;gap:8px;align-items:center">
            <button class="btn btn-sm btn-secondary" data-notif-read>Mark all read</button>
            <a class="btn btn-sm btn-secondary" href="/notifications.html">Open page</a>
          </div>
        </div>
        ${rows.length ? rows.slice(0, 12).map((n) => `
          <a class="notif-item ${Number(n.is_read) ? '' : 'unread'}" href="${UI.esc(n.link || '/notifications.html')}" data-notif-id="${n.id}">
            <span class="notif-ic">${this.notifIcon(n.type)}</span>
            <span style="flex:1;min-width:0">
              <span class="notif-title">${UI.esc(n.title)}</span>
              <div class="notif-msg">${UI.esc(n.message)}</div>
              <div class="notif-time">${UI.timeAgo(n.created_at)}</div>
            </span>
          </a>`).join('') : UI.empty('No notifications yet', 'Likes, comments, follows and event reminders show up here.')}
      `;
      const readBtn = panel.querySelector('[data-notif-read]');
      if (readBtn) readBtn.addEventListener('click', async () => {
        try {
          await API.put('/notifications/read-all');
          panel.querySelectorAll('.notif-item').forEach((el) => el.classList.remove('unread'));
          UI.setNotifBadge(0);
          UI.toast('All notifications marked read', 'success');
        } catch (err) { UI.toast(err.message, 'error'); }
      });
    } catch (err) {
      panel.innerHTML = `<div style="padding:18px"><div class="error-box">${UI.esc(err.message)}</div></div>`;
    }
    if (anchor && anchor.getBoundingClientRect) {
      const r = anchor.getBoundingClientRect();
      panel.style.top = `${Math.min(window.innerHeight - 120, r.bottom + 8)}px`;
    }
  },

  /* ==========================================================
     Discover rail (trending, events, people, communities)
     ========================================================== */
  /**
   * Trending discussions, de-duplicated and prioritised for variety.
   * The backend ranks purely by comment count, which on a small campus
   * buries everything under one popular thread. This prefers real,
   * substantive discussions (a body, or an actual question title) over
   * near-empty posts, drops exact repeat titles, and backfills with
   * recent active posts so the rail never shows the same item twice.
   */
  trendingDiscussions(raw, limit = 5) {
    const rows = Array.isArray(raw) ? raw : [];
    const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
    const titleOf = (t) => {
      const src = norm(t.title) || norm(t.content);
      return src.length > 74 ? `${src.slice(0, 74)}\u2026` : src;
    };
    const eng = (t) => Number(t.comment_count || 0) * 3 + Number(t.like_count || 0);
    // A real discussion has a body, or a title that actually asks something.
    const substantive = (t) => norm(t.content).length > 40 || /^.+\?$/.test(norm(t.title));

    const seen = new Set();
    const picked = [];
    const take = (t) => {
      const k = titleOf(t);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      picked.push(t);
      return true;
    };
    rows.filter(substantive).sort((a, b) => eng(b) - eng(a)).forEach((t) => { if (picked.length < limit) take(t); });
    rows.filter((t) => !substantive(t)).sort((a, b) => eng(b) - eng(a)).forEach((t) => { if (picked.length < limit) take(t); });
    return picked.slice(0, limit);
  },

  async mountDiscover(els) {
    let d;
    try {
      const res = await API.get('/social/discover');
      d = res.data;
    } catch (_e) { return; }
    if (!d) return;

    if (els.discussions) {
      const disc = this.trendingDiscussions(d.trending_discussions);
      els.discussions.innerHTML = disc.length ? disc.map((t) => {
        const full = String(t.title || t.content || '').trim();
        const shown = full.length > 74 ? `${full.slice(0, 74)}\u2026` : full;
        const meta = [t.community_name && `#${UI.esc(t.community_name)}`]
          .concat([`${Number(t.comment_count || 0)} comments`, `${Number(t.like_count || 0)} likes`])
          .filter(Boolean).join(' &middot; ');
        return `<a class="disc-item" href="/feed.html?post=${t.id}">
          <div class="di-title" title="${UI.esc(full)}">${UI.esc(shown)}</div>
          <div class="di-meta">${meta}</div>
        </a>`;
      }).join('') : '<div class="ri-meta" style="padding:4px 8px">No discussions yet \u2014 start the first one.</div>';
    }

    if (els.events) {
      els.events.innerHTML = (d.upcoming_events || []).length ? d.upcoming_events.map((e) => `
        <a class="rail-item" href="/event-details.html?id=${e.id}">
          <span style="min-width:0">
            <b>${UI.esc(e.title.slice(0, 34))}</b>
            <div class="ri-meta">${UI.fmtDate(e.event_date)} &middot; ${UI.esc(e.venue || '')}</div>
          </span>
          <span class="ri-meta">${e.is_official ? '&#10003; Official' : 'Student'}</span>
        </a>`).join('') : '<div class="ri-meta" style="padding:4px 8px">No upcoming events.</div>';
    }

    if (els.communities) {
      els.communities.innerHTML = (d.popular_communities || []).map((c) => `
        <a class="rail-item" href="/community.html?slug=${UI.esc(c.slug)}">
          <span><b>#${UI.esc(c.slug)}</b><div class="ri-meta">${c.member_count} members</div></span>
          <span class="ri-meta">${c.post_count} posts</span>
        </a>`).join('');
    }

    if (els.people) {
      els.people.innerHTML = (d.suggested_people || []).length ? d.suggested_people.map((p) => `
        <div class="suggest-row">
          ${p.avatar_path ? `<img class="post-avatar avatar-sm" src="${UI.esc(p.avatar_path)}" alt="">`
            : `<span class="post-avatar avatar-sm">${UI.esc((p.full_name || '?').charAt(0).toUpperCase())}</span>`}
          <span class="sr-main">
            <a class="pb-name" href="/profile.html?id=${p.id}" style="font-size:13.5px">
              ${UI.esc(p.full_name)}
              ${p.verified ? '<span class="vbadge" title="Verified">&#10003;</span>' : ''}
            </a>
            <div class="ri-meta">${UI.esc(p.dept_code || (p.account_type !== 'student' ? 'Official account' : 'Student'))}${p.year ? ` &middot; Year ${p.year}` : ''}</div>
          </span>
          <button class="btn btn-sm " data-rail-follow="${p.id}">Follow</button>
        </div>`).join('') : '<div class="ri-meta" style="padding:4px 8px">You follow everyone already.</div>';

      els.people.querySelectorAll('[data-rail-follow]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!Auth.user()) { location.href = '/login.html?next=%2Ffeed.html'; return; }
          btn.disabled = true;
          try {
            const r = await API.put(`/social/users/${btn.dataset.railFollow}/follow`);
            btn.classList.toggle('btn-secondary', !r.data.following);
            btn.textContent = r.data.following ? 'Following' : 'Follow';
            playOnce(btn, 'pop');
            UI.toast(r.message, 'success');
          } catch (err) { UI.toast(err.message, 'error'); }
          btn.disabled = false;
        });
      });
    }

    if (els.tags && d.trending_tags) {
      els.tags.innerHTML = d.trending_tags.map((t) => `
        <a class="trend-tag" href="/community.html?slug=${UI.esc(t.slug)}">#${UI.esc(t.slug)} <span class="ri-meta">${t.post_count}</span></a>`).join('');
    }

    if (els.poll && d.daily_poll) {
      els.poll.innerHTML = `
        <a class="rail-item" href="/feed.html?post=${d.daily_poll.id}">
          <span><b>${UI.esc((d.daily_poll.poll_question || '').slice(0, 60))}</b>
            <div class="ri-meta">${d.daily_poll.vote_count} votes &middot; ${d.daily_poll.option_count} options</div></span>
          <span class="ri-meta">Vote &#8594;</span>
        </a>`;
    }

    if (els.achievements && d.recent_achievements) {
      els.achievements.innerHTML = d.recent_achievements.length ? d.recent_achievements.map((a) => `
        <a class="rail-item" href="/achievement-details.html?id=${a.id}">
          <span><b>&#127942; ${UI.esc(String(a.title).slice(0, 34))}</b>
            <div class="ri-meta">${UI.esc(a.competition_name || '')}</div></span>
        </a>`).join('') : '<div class="ri-meta" style="padding:4px 8px">No achievements yet.</div>';
    }
  },

  async openComments(postId, wrap) {
    wrap.classList.add('open');
    const list = wrap.querySelector('[data-comments-list]');
    try {
      const res = await API.get(`/social/posts/${postId}/comments`);
      list.innerHTML = res.data.length ? this.renderComments(res.data, !!Auth.user(), Auth.user())
        : '<div class="pb-sub" style="margin-top:8px">No comments yet. Start the conversation!</div>';
    } catch (err) {
      list.innerHTML = `<div class="error-box">${UI.esc(err.message)}</div>`;
    }
  },

  openShare(anchorBtn, postId) {
    let pop = document.getElementById('share-pop');
    if (!pop) {
      pop = document.createElement('div');
      pop.id = 'share-pop';
      pop.className = 'share-pop';
      document.body.appendChild(pop);
    }
    const url = `${location.origin}/feed.html?post=${postId}`;
    const r = anchorBtn.getBoundingClientRect();
    pop.style.top = `${Math.min(window.innerHeight - 160, r.bottom + 6)}px`;
    pop.style.left = `${Math.max(8, r.left - 120)}px`;
    pop.innerHTML = `
      <button data-share-copy="${UI.esc(url)}">&#128203; Copy link</button>
      <button data-share-x="${encodeURIComponent(`Check this out on CollegeConnect! ${url}`)}">&#120143; Post on X</button>
      <button data-share-wa="${encodeURIComponent(url)}">&#128172; WhatsApp</button>`;
    pop.classList.add('open');
    if (!pop.dataset.bound) {
      pop.dataset.bound = '1';
      document.addEventListener('click', async (e) => {
        const p2 = document.getElementById('share-pop');
        if (!p2 || !p2.classList.contains('open')) return;
        if (!e.target.closest('#share-pop') && !e.target.closest('[data-share]')) { p2.classList.remove('open'); return; }
        const copyBtn = e.target.closest('[data-share-copy]');
        if (copyBtn) {
          try { await navigator.clipboard.writeText(copyBtn.dataset.shareCopy); UI.toast('Link copied', 'success'); }
          catch (_e) { await UI.prompt('Copy this link:', { value: copyBtn.dataset.shareCopy, required: false }); }
          p2.classList.remove('open');
        }
        const xBtn = e.target.closest('[data-share-x]');
        if (xBtn) { window.open(`https://twitter.com/intent/tweet?text=${xBtn.dataset.shareX}`, '_blank'); p2.classList.remove('open'); }
        const waBtn = e.target.closest('[data-share-wa]');
        if (waBtn) { window.open(`https://wa.me/?text=${waBtn.dataset.shareWa}`, '_blank'); p2.classList.remove('open'); }
      });
    }
  },
};
