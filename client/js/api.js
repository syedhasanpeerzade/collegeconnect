'use strict';
/* CollegeConnect API client */
const API = {
  token: () => localStorage.getItem('cc_token') || '',

  async request(path, { method = 'GET', body, formData } = {}) {
    const headers = {};
    const token = localStorage.getItem('cc_token');
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';

    const res = await fetch(`/api${path}`, {
      method,
      headers,
      body: formData ? formData : body ? JSON.stringify(body) : undefined,
    });

    let data = null;
    try { data = await res.json(); } catch (_e) { /* non-JSON */ }

    if (res.status === 401 && token) {
      localStorage.removeItem('cc_token');
      localStorage.removeItem('cc_user');
      // Do not redirect from public pages
      if (!['/login.html', '/register.html', '/'].includes(location.pathname)) {
        location.href = `/login.html?expired=1&next=${encodeURIComponent(location.pathname + location.search)}`;
      }
    }
    if (!res.ok || (data && data.success === false)) {
      const err = new Error((data && data.message) || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  },

  get(path) { return this.request(path); },
  post(path, body) { return this.request(path, { method: 'POST', body }); },
  postForm(path, formData) { return this.request(path, { method: 'POST', formData }); },
  /**
   * Multipart upload with real progress callback (XHR; fetch cannot report it).
   * onProgress receives 0..100. Same error/redirect behavior as request().
   */
  postFormProgress(path, formData, onProgress) {
    return new Promise((resolve, reject) => {
      const token = localStorage.getItem('cc_token');
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api${path}`);
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
      });
      xhr.addEventListener('load', () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch (_e) { /* non-JSON */ }
        if (xhr.status === 401 && token) {
          localStorage.removeItem('cc_token'); localStorage.removeItem('cc_user');
          if (!['/login.html', '/register.html', '/'].includes(location.pathname)) {
            location.href = `/login.html?expired=1&next=${encodeURIComponent(location.pathname + location.search)}`;
          }
        }
        if (xhr.status >= 400 || (data && data.success === false)) {
          const err = new Error((data && data.message) || `Request failed (${xhr.status})`);
          err.status = xhr.status; err.data = data; reject(err); return;
        }
        resolve(data);
      });
      xhr.addEventListener('error', () => reject(new Error('Network error during upload')));
      xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')));
      xhr.send(formData);
    });
  },
  put(path, body) { return this.request(path, { method: 'PUT', body }); },
  putForm(path, formData) { return this.request(path, { method: 'PUT', formData }); },
  patch(path, body) { return this.request(path, { method: 'PATCH', body }); },
  del(path) { return this.request(path, { method: 'DELETE' }); },
};

/* Current user helpers */
const Auth = {
  user() {
    try { return JSON.parse(localStorage.getItem('cc_user') || 'null'); } catch (_e) { return null; }
  },
  save(user, token) {
    localStorage.setItem('cc_user', JSON.stringify(user));
    if (token) localStorage.setItem('cc_token', token);
  },
  logout() {
    const token = localStorage.getItem('cc_token');
    if (token) { API.post('/auth/logout').catch(() => {}); }
    localStorage.removeItem('cc_token');
    localStorage.removeItem('cc_user');
  },
  requireRole(roles) {
    const u = this.user();
    const onLoginPage = location.pathname === '/login.html';
    if (!u && !onLoginPage) {
      location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
      return null;
    }
    if (u && roles && !roles.includes(u.role)) {
      location.href = this.dashboardFor(u.role);
      return null;
    }
    return u;
  },
  dashboardFor(role) {
    return {
      STUDENT: '/dashboard.html',
      ORGANIZER: '/organizer/index.html',
      CLUB_COORDINATOR: '/coordinator/index.html',
      FACULTY: '/faculty/index.html',
      ADMIN: '/admin/index.html',
    }[role] || '/dashboard.html';
  },
};
