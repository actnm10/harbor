'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const titles = { all: 'All files', image: 'Photos', video: 'Videos', audio: 'Audio', documents: 'Documents' };
  const imageTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);
  const documentExtensions = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'log', 'ini', 'conf', 'cfg', 'js', 'ts', 'css', 'py', 'sh', 'c', 'h', 'cpp', 'java', 'sql', 'doc', 'docx', 'pdf', 'xls', 'xlsx', 'ppt', 'pptx']);
  const spreadsheetExtensions = new Set(['xls', 'xlsx', 'xlsm', 'xlsb', 'xlt', 'xltx', 'xltm', 'csv', 'tsv', 'ods', 'ots']);
  const presentationExtensions = new Set(['ppt', 'pptx', 'pptm', 'pps', 'ppsx', 'ppsm', 'pot', 'potx', 'potm', 'odp', 'otp']);
  const textDocumentExtensions = new Set([...documentExtensions, 'rtf', 'docm', 'dot', 'dotx', 'dotm', 'odt', 'ott', 'pages']);
  const spreadsheetMimes = new Set(['application/vnd.ms-excel', 'application/msexcel', 'application/x-msexcel', 'application/x-ms-excel', 'application/excel', 'application/x-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.spreadsheetml.template', 'application/vnd.ms-excel.sheet.macroenabled.12', 'application/vnd.ms-excel.sheet.binary.macroenabled.12', 'application/vnd.ms-excel.template.macroenabled.12', 'application/vnd.oasis.opendocument.spreadsheet', 'application/vnd.oasis.opendocument.spreadsheet-template', 'text/csv', 'text/tab-separated-values']);
  const presentationMimes = new Set(['application/vnd.ms-powerpoint', 'application/mspowerpoint', 'application/powerpoint', 'application/x-mspowerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.openxmlformats-officedocument.presentationml.slideshow', 'application/vnd.openxmlformats-officedocument.presentationml.template', 'application/vnd.ms-powerpoint.presentation.macroenabled.12', 'application/vnd.ms-powerpoint.slideshow.macroenabled.12', 'application/vnd.ms-powerpoint.template.macroenabled.12', 'application/vnd.oasis.opendocument.presentation', 'application/vnd.oasis.opendocument.presentation-template']);
  const textDocumentMimes = new Set(['application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.template', 'application/vnd.ms-word.document.macroenabled.12', 'application/vnd.ms-word.template.macroenabled.12', 'application/rtf', 'application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.text-template', 'application/json', 'application/xml']);
  const fileKindLabels = { folder: 'Folder', image: 'Image', video: 'Video', audio: 'Audio', document: 'Document', spreadsheet: 'Spreadsheet', presentation: 'Presentation', pdf: 'PDF document', file: 'File' };
  const state = { user: null, csrf: '', limits: {}, items: [], breadcrumbs: [], route: { parent: 'root', type: 'all', q: '' }, view: 'grid', sort: 'name', loading: false, loadFailed: false, loadController: null, uploads: [], uploading: false, dialogBusy: false };
  let searchTimer;
  let refreshTimer;
  let dragDepth = 0;
  let dialogSubmit = null;
  let uploadSequence = 0;
  let previewCleanup = null;
  let previewGeneration = 0;
  let adminData = null;
  let adminBusy = false;
  let adminController = null;
  let adminGeneration = 0;
  let adminUploadUnit = 1073741824;
  const csrfErrorMessage = 'Invalid security token. Refresh the page and try again.';
  let authEpoch = 0;
  let csrfRefresh = null;
  let loginBusy = false;
  let authCooldownUntil = 0;
  let authCooldownTimer = null;
  let dialogIsPassword = false;
  let dialogSubmitLabel = 'Save';

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    return svg;
  }

  function bytes(value) {
    const size = Math.max(0, Number(value) || 0);
    if (!size) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const index = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: index ? 1 : 0 }).format(size / 1024 ** index) + ' ' + units[index];
  }

  function date(value) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return '—';
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: parsed.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined }).format(parsed);
  }

  function contentUrl(item, download = false) {
    return '/api/files/' + encodeURIComponent(item.id) + '/content' + (download ? '?download=1' : '');
  }

  function fileExtension(name) {
    if (typeof name !== 'string' || name.lastIndexOf('.') <= 0) return '';
    return name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  }

  function canPreviewDocument(item) {
    return item.kind !== 'folder' && documentExtensions.has(fileExtension(item.name));
  }

  function classify(item) {
    if (item.kind === 'folder') return 'folder';
    const mime = String(item.mime || item.type || '').split(';', 1)[0].trim().toLowerCase();
    const extension = fileExtension(item.name);
    if (imageTypes.has(mime)) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime === 'application/pdf' || mime === 'application/x-pdf') return 'pdf';
    if (spreadsheetMimes.has(mime)) return 'spreadsheet';
    if (presentationMimes.has(mime)) return 'presentation';
    if (extension === 'pdf') return 'pdf';
    if (spreadsheetExtensions.has(extension)) return 'spreadsheet';
    if (presentationExtensions.has(extension)) return 'presentation';
    if (mime.startsWith('text/') || textDocumentMimes.has(mime) || textDocumentExtensions.has(extension)) return 'document';
    return 'file';
  }

  function fileIcon(kind) {
    const result = icon({ document: 'document', spreadsheet: 'sheet', presentation: 'slides', pdf: 'pdf' }[kind] || kind);
    result.classList.add('file-type-symbol');
    return result;
  }

  function toast(message, isError = false) {
    const node = element('div', 'toast' + (isError ? ' error' : ''));
    node.append(icon(isError ? 'info' : 'check'), element('span', '', message));
    $('toasts').append(node);
    window.setTimeout(() => node.remove(), isError ? 8500 : 4500);
  }

  function retryDeadline(response) {
    const value = response.headers.get('Retry-After');
    if (!value) return 0;
    const now = Date.now();
    const deadline = /^\d+$/.test(value.trim()) ? now + Number(value) * 1000 : Date.parse(value);
    return Number.isSafeInteger(deadline) && deadline > now ? deadline : 0;
  }

  function authErrorMessage(error) {
    return error.message + (error.status === 429 && error.retryAt > Date.now() ? ' You can try again at ' + new Date(error.retryAt).toLocaleTimeString() + '.' : '');
  }

  function updateAuthControls() {
    window.clearTimeout(authCooldownTimer);
    authCooldownTimer = null;
    const remaining = Math.max(0, Math.ceil((authCooldownUntil - Date.now()) / 1000));
    if (!remaining) authCooldownUntil = 0;
    const waiting = 'Try again in ' + Math.floor(remaining / 60) + ':' + String(remaining % 60).padStart(2, '0');
    const loginVisible = !$('login-view').hidden;
    $('sign-in').disabled = loginBusy || (loginVisible && remaining > 0);
    if (loginBusy) $('sign-in').textContent = 'Signing in…';
    else if (loginVisible && remaining) $('sign-in').textContent = waiting;
    else $('sign-in').replaceChildren(document.createTextNode('Sign in '), icon('chevron'));
    const passwordVisible = dialogIsPassword && $('form-dialog').open;
    if (passwordVisible) {
      $('dialog-submit').disabled = state.dialogBusy || remaining > 0;
      $('dialog-submit').textContent = state.dialogBusy ? 'Working…' : remaining ? waiting : dialogSubmitLabel;
    }
    if (remaining && (loginVisible || passwordVisible)) authCooldownTimer = window.setTimeout(updateAuthControls, Math.min(1000, authCooldownUntil - Date.now()));
  }

  function honorAuthCooldown(error) {
    if (error.status === 429 && error.retryAt > Date.now()) authCooldownUntil = Math.max(authCooldownUntil, error.retryAt);
    updateAuthControls();
  }

  function applySession(session) {
    state.user = session.user;
    state.csrf = session.csrfToken;
    state.limits = session.limits || {};
    $('username').value = session.user.username;
    $('account-name').textContent = session.user.username;
    $('admin-settings').hidden = session.user.role !== 'admin';
    $('account-role').textContent = session.user.role === 'admin' ? 'Administrator' : 'Personal account';
    $('avatar').textContent = (session.user.username || 'H').slice(0, 1).toUpperCase();
    $('upload-limit').textContent = 'Up to ' + bytes(state.limits.maxUploadBytes) + ' per file';
  }

  async function recoverCsrf(expectedToken, epoch) {
    if (!state.user || epoch !== authEpoch) return false;
    if (state.csrf !== expectedToken) return !!state.csrf;
    if (!csrfRefresh || csrfRefresh.epoch !== epoch) {
      const refresh = { epoch, promise: null };
      refresh.promise = api('/api/session').then(session => {
        if (state.user && epoch === authEpoch && state.csrf === expectedToken) applySession(session);
      }).catch(error => {
        if (error.status === 401 && epoch === authEpoch) expireSession();
        throw error;
      }).finally(() => { if (csrfRefresh === refresh) csrfRefresh = null; });
      csrfRefresh = refresh;
    }
    await csrfRefresh.promise;
    return !!state.user && epoch === authEpoch && !!state.csrf && state.csrf !== expectedToken;
  }

  async function api(path, options = {}, canRecoverCsrf = true) {
    const method = options.method || 'GET';
    const requestEpoch = authEpoch;
    const requestCsrf = state.csrf;
    const headers = { ...options.headers };
    if (method !== 'GET' && method !== 'HEAD') headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && method !== 'HEAD' && path !== '/api/login') headers['X-CSRF-Token'] = state.csrf;
    let response;
    try {
      response = await fetch(path, { ...options, method, headers, credentials: 'same-origin', body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new Error(error.name === 'TimeoutError' ? 'The server took too long to respond. Please try again.' : 'Couldn’t reach your server. Check your connection and try again.');
    }
    let data = null;
    if (response.status !== 204) {
      try { data = await response.json(); } catch { /* A proxy may send a non-JSON error. */ }
    }
    if (!response.ok) {
      if (canRecoverCsrf && method !== 'GET' && method !== 'HEAD' && path !== '/api/login' && response.status === 403 && data?.error === csrfErrorMessage && await recoverCsrf(requestCsrf, requestEpoch)) {
        return api(path, options, false);
      }
      if (response.status === 401 && requestEpoch === authEpoch && path !== '/api/login' && path !== '/api/session') {
        if (path === '/api/password') {
          try { await api('/api/session'); } catch (sessionError) { if (sessionError.status === 401 && requestEpoch === authEpoch) expireSession(); }
        } else expireSession();
      }
      const error = new Error(data?.error || 'The request could not be completed. Please try again.');
      error.status = response.status;
      error.retryAt = retryDeadline(response);
      throw error;
    }
    return data;
  }

  function setLoginMessage(message) {
    $('login-error').textContent = message;
    $('login-error').hidden = !message;
  }

  function showLogin(message = '') {
    authEpoch++;
    csrfRefresh = null;
    dialogIsPassword = false;
    cleanPreview();
    adminController?.abort();
    adminGeneration++;
    adminData = null;
    $('admin-dialog').close();
    $('admin-content').hidden = true;
    $('admin-settings').hidden = true;
    $('admin-form').reset();
    $('admin-storage-form').reset();
    $('admin-storage-location').replaceChildren();
    for (const id of ['admin-storage-root', 'admin-location-path', 'admin-location-usage', 'admin-data-dir', 'admin-usage', 'admin-error', 'admin-storage-error', 'admin-save-status', 'admin-storage-status']) $(id).textContent = '';
    state.user = null;
    state.csrf = '';
    state.limits = {};
    state.items = [];
    state.breadcrumbs = [];
    state.route = { parent: 'root', type: 'all', q: '' };
    state.loading = false;
    state.loadFailed = false;
    state.loadController?.abort();
    state.loadController = null;
    window.clearTimeout(searchTimer);
    window.clearTimeout(refreshTimer);
    for (const upload of state.uploads) {
      upload.status = 'canceled';
      upload.xhr?.abort();
    }
    state.uploads = [];
    renderUploads();
    history.replaceState(null, '', location.pathname + location.search);
    $('boot').hidden = true;
    $('app-view').hidden = true;
    $('login-view').hidden = false;
    $('files').replaceChildren();
    $('toasts').replaceChildren();
    $('breadcrumbs').replaceChildren();
    $('search').value = '';
    $('username').value = '';
    $('password').value = '';
    $('file-input').value = '';
    $('account-name').textContent = 'Owner';
    $('account-role').textContent = 'Personal account';
    $('avatar').textContent = 'H';
    $('page-title').textContent = 'All files';
    $('page-subtitle').textContent = 'Everything you need, right where you left it.';
    $('section-title').textContent = 'Your files';
    $('item-count').textContent = '';
    $('load-error-message').textContent = '';
    $('empty-title').textContent = 'Your space starts here.';
    $('empty-description').textContent = '';
    $('drag-destination').textContent = 'Upload files to My files';
    $('drag-overlay').hidden = true;
    $('upload-button').removeAttribute('title');
    $('new-folder').removeAttribute('title');
    $('upload-limit').textContent = '';
    updateStats({});
    $('password').type = 'password';
    $('show-password').textContent = 'Show';
    $('show-password').setAttribute('aria-label', 'Show password');
    $('show-password').setAttribute('aria-pressed', 'false');
    $('form-dialog').close();
    $('preview-dialog').close();
    $('dialog-title').textContent = '';
    $('dialog-description').textContent = '';
    $('dialog-fields').replaceChildren();
    $('dialog-error').textContent = '';
    dialogSubmit = null;
    $('preview-title').textContent = '';
    $('preview-meta').textContent = '';
    $('preview-file-icon').replaceChildren();
    $('preview-file-icon').className = 'file-type-icon preview-type-icon';
    $('preview-download').removeAttribute('href');
    $('preview-download').removeAttribute('download');
    $('preview-content').querySelectorAll('video,audio').forEach(media => { media.pause(); media.removeAttribute('src'); media.load(); });
    $('preview-content').replaceChildren();
    $('preview-error').textContent = '';
    closeSidebar();
    setLoginMessage(message);
    updateAuthControls();
    document.title = 'Sign in · Harbor';
    window.setTimeout(() => ($('username').value ? $('password') : $('username')).focus(), 0);
  }

  function expireSession() {
    if (!state.user) return;
    for (const upload of state.uploads) {
      if (upload.status === 'queued' || upload.status === 'uploading') {
        upload.status = 'failed';
        upload.error = 'Your session ended. Sign in, then retry this upload.';
        upload.xhr?.abort();
      }
    }
    renderUploads();
    showLogin('Your session has ended. Sign in again to continue.');
  }

  async function showApp(session) {
    authEpoch++;
    applySession(session);
    $('password').value = '';
    $('boot').hidden = true;
    $('login-view').hidden = true;
    $('app-view').hidden = false;
    updateAuthControls();
    await readRoute();
  }

  function routeHash(parent = 'root', type = 'all', q = '') {
    const params = new URLSearchParams({ folder: parent });
    if (type !== 'all') params.set('type', type);
    if (q) params.set('q', q);
    return '#' + params.toString();
  }

  function navigate(parent = 'root', type = 'all', q = '', replace = false) {
    const hash = routeHash(parent, type, q);
    if (replace) {
      history.replaceState(null, '', hash);
      readRoute();
    } else if (location.hash === hash) {
      readRoute();
    } else {
      location.hash = hash;
    }
  }

  async function readRoute() {
    if (!state.user) return;
    window.clearTimeout(searchTimer);
    const params = new URLSearchParams(location.hash.slice(1));
    const type = Object.hasOwn(titles, params.get('type')) ? params.get('type') : 'all';
    const q = (params.get('q') || '').slice(0, 255);
    state.route = { parent: params.get('folder') || 'root', type, q };
    if ($('search').value !== q) $('search').value = q;
    document.querySelectorAll('.nav-item').forEach(link => {
      const selected = link.dataset.type === type;
      link.classList.toggle('active', selected);
      if (selected) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    });
    closeSidebar();
    await loadFiles();
  }

  async function loadFiles() {
    if (!state.user) return;
    state.loadController?.abort();
    const controller = new AbortController();
    state.loadController = controller;
    state.loading = true;
    state.loadFailed = false;
    $('files').hidden = true;
    $('list-heading').hidden = true;
    $('empty-state').hidden = true;
    $('load-error').hidden = true;
    $('files-loading').hidden = false;
    $('item-count').textContent = '';
    const { parent, type, q } = state.route;
    updateTitle();
    try {
      const params = new URLSearchParams({ parent, type, q });
      const result = await api('/api/files?' + params, { signal: controller.signal });
      if (controller !== state.loadController || !state.user) return;
      state.items = result.items || [];
      state.breadcrumbs = result.breadcrumbs || [];
      state.loading = false;
      updateStats(result.stats || {});
      updateBreadcrumbs();
      updateTitle();
      renderFiles();
    } catch (error) {
      if (error.name === 'AbortError' || controller !== state.loadController || !state.user) return;
      state.loading = false;
      state.loadFailed = true;
      $('files-loading').hidden = true;
      $('load-error').hidden = false;
      $('load-error-message').textContent = error.message;
      state.breadcrumbs = [{ id: 'root', name: 'My files' }];
      updateBreadcrumbs();
    }
  }

  function currentFolderName() {
    return state.breadcrumbs.at(-1)?.name || 'My files';
  }

  function isGlobal() { return state.route.type !== 'all' || !!state.route.q; }
  function uploadParent() { return isGlobal() ? 'root' : state.route.parent; }
  function destinationName() { return isGlobal() ? 'My files' : currentFolderName(); }

  function updateTitle() {
    const { type, q, parent } = state.route;
    const title = q ? 'Search results' : type !== 'all' ? titles[type] : parent === 'root' ? 'All files' : currentFolderName();
    $('page-title').replaceChildren(document.createTextNode(title), element('span', 'title-dot', '.'));
    $('page-subtitle').textContent = q ? 'Matches for “' + q + '” across your entire library.' : type !== 'all' ? 'A collection from across your entire library.' : parent === 'root' ? 'Everything you need, right where you left it.' : 'A little order for the things you keep.';
    $('section-title').textContent = q ? 'Matching files & folders' : type === 'all' ? 'Your files' : 'Your ' + titles[type].toLowerCase();
    $('drag-destination').textContent = 'Upload files to ' + destinationName();
    $('upload-button').title = 'Upload to ' + destinationName();
    $('new-folder').title = 'Create a folder in ' + destinationName();
    $('drop-zone').querySelector('strong').textContent = isGlobal() ? 'New uploads go to My files.' : 'A place for whatever comes next.';
    document.title = title + ' · Harbor';
  }

  function updateBreadcrumbs() {
    const holder = $('breadcrumbs');
    holder.replaceChildren();
    const crumbs = isGlobal() ? [{ id: 'root', name: 'My files' }, { name: state.route.q ? 'Search' : titles[state.route.type] }] : state.breadcrumbs;
    crumbs.forEach((crumb, index) => {
      if (index) holder.append(icon('chevron'));
      const last = index === crumbs.length - 1;
      const node = element(last ? 'span' : 'a', '', crumb.name);
      if (last) node.setAttribute('aria-current', 'page'); else node.href = routeHash(crumb.id);
      if (index === 0) node.prepend(icon('folder'));
      holder.append(node);
    });
  }

  function updateStats(stats) {
    const max = Number(stats.maxStorageBytes || state.limits.maxStorageBytes || 0);
    const used = Number(stats.usedBytes || 0);
    const percent = max ? Math.min(100, used / max * 100) : 0;
    $('storage-used').textContent = bytes(used);
    $('storage-max').textContent = bytes(max);
    $('storage-percent').textContent = Math.round(percent) + '%';
    $('storage-progress').value = percent;
    $('storage-progress').setAttribute('aria-valuetext', bytes(used) + ' of ' + bytes(max) + ' used');
    $('count-all').textContent = stats.fileCount || 0;
    $('count-image').textContent = stats.imageCount || 0;
    $('count-video').textContent = stats.videoCount || 0;
    $('count-audio').textContent = stats.audioCount || 0;
  }

  function sortedItems() {
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    return [...state.items].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
      if (state.sort === 'newest') return new Date(b.updatedAt) - new Date(a.updatedAt) || collator.compare(a.name, b.name);
      if (state.sort === 'oldest') return new Date(a.updatedAt) - new Date(b.updatedAt) || collator.compare(a.name, b.name);
      if (state.sort === 'size') return Number(b.size || 0) - Number(a.size || 0) || collator.compare(a.name, b.name);
      return collator.compare(a.name, b.name);
    });
  }

  function menuAction(label, iconName, handler, className = '') {
    const button = element('button', className);
    button.type = 'button';
    button.append(icon(iconName), document.createTextNode(label));
    button.addEventListener('click', handler);
    return button;
  }

  function renderFiles() {
    if (state.loading || state.loadFailed) return;
    $('files-loading').hidden = true;
    $('load-error').hidden = true;
    const holder = $('files');
    holder.replaceChildren();
    holder.className = state.view === 'list' ? 'file-list' : 'file-grid';
    holder.hidden = !state.items.length;
    $('list-heading').hidden = state.view !== 'list' || !state.items.length;
    $('empty-state').hidden = !!state.items.length;
    $('item-count').textContent = state.items.length + (state.items.length === 1 ? ' item' : ' items');
    if (!state.items.length) {
      const filtered = isGlobal();
      $('empty-title').textContent = state.route.q ? 'Nothing by that name, yet.' : state.route.type !== 'all' ? 'Your ' + titles[state.route.type].toLowerCase() + ' will feel at home here.' : state.route.parent !== 'root' ? 'A fresh little space.' : 'Your space starts here.';
      $('empty-description').textContent = state.route.q ? 'Try another search, or return to all your files.' : state.route.type !== 'all' ? 'Upload files and they’ll appear here automatically when their format matches this collection.' : 'Bring your photos, documents, and big ideas. Upload your first file to make yourself at home.';
      $('empty-action').replaceChildren(icon(state.route.q ? 'folder' : 'upload'), element('span', '', state.route.q ? 'Back to all files' : filtered ? 'Upload files' : 'Upload your first file'));
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const item of sortedItems()) {
      const kind = classify(item);
      const card = element('article', 'file-card kind-' + kind);
      const open = element('button', 'file-open');
      open.type = 'button';
      open.setAttribute('aria-label', (item.kind === 'folder' ? 'Open folder ' : 'Preview ' + fileKindLabels[kind].toLowerCase() + ' ') + item.name);
      open.addEventListener('click', () => item.kind === 'folder' ? navigate(item.id) : openPreview(item));
      const visual = element('div', 'file-visual');
      if (kind === 'image') {
        const image = element('img');
        image.src = contentUrl(item);
        image.alt = '';
        image.loading = 'lazy';
        image.decoding = 'async';
        image.addEventListener('error', () => visual.replaceChildren(fileIcon('image')), { once: true });
        visual.append(image);
      } else {
        visual.append(fileIcon(kind));
        if (item.kind !== 'folder') {
          const extension = fileExtension(item.name).slice(0, 9).toUpperCase() || 'FILE';
          visual.append(element('span', 'file-extension', extension));
        }
      }
      const info = element('div', 'file-info');
      const name = element('span', 'file-name', item.name);
      name.title = item.name;
      const meta = element('span', 'file-meta');
      const size = element('span', 'file-size', item.kind === 'folder' ? 'Folder' : bytes(item.size));
      const modified = element('span', 'file-date', date(item.updatedAt));
      modified.title = new Date(item.updatedAt).toLocaleString();
      meta.append(size, element('span', 'meta-dot'), modified);
      info.append(name, meta);
      open.append(visual, info);
      const menu = element('details', 'file-menu');
      const summary = element('summary');
      summary.setAttribute('aria-label', 'Actions for ' + item.name);
      summary.title = 'File actions';
      summary.append(icon('more'));
      const panel = element('div', 'file-menu-panel');
      const closeAnd = fn => () => { menu.open = false; fn(); };
      if (item.kind === 'file') {
        const download = element('a');
        download.href = contentUrl(item, true);
        download.download = item.name;
        download.append(icon('download'), document.createTextNode('Download'));
        download.addEventListener('click', () => { menu.open = false; });
        panel.append(download);
      }
      panel.append(menuAction('Rename', 'edit', closeAnd(() => renameItem(item))));
      panel.append(menuAction('Delete', 'trash', closeAnd(() => deleteItem(item)), 'delete-action'));
      menu.append(summary, panel);
      menu.addEventListener('toggle', () => {
        if (menu.open) document.querySelectorAll('.file-menu[open], .account-menu[open]').forEach(other => { if (other !== menu) other.open = false; });
      });
      card.append(open, menu);
      fragment.append(card);
    }
    holder.append(fragment);
  }

  function setView(view) {
    state.view = view;
    for (const value of ['grid', 'list']) {
      $(value + '-view').classList.toggle('selected', value === view);
      $(value + '-view').setAttribute('aria-pressed', String(value === view));
    }
    try { localStorage.setItem('harbor-view', view); } catch { /* Storage can be unavailable in private browser modes. */ }
    if (state.user && !state.loading) renderFiles();
  }

  function closeSidebar() {
    const wasOpen = $('sidebar').classList.contains('is-open');
    const mobile = window.matchMedia('(max-width: 700px)').matches;
    $('sidebar').classList.remove('is-open');
    $('sidebar').inert = mobile;
    $('sidebar-shade').hidden = true;
    $('mobile-menu').setAttribute('aria-expanded', 'false');
    $('workspace').inert = false;
    if (wasOpen && mobile && !$('app-view').hidden) $('mobile-menu').focus();
  }

  function openDialog({ title, description, iconName = 'folder', danger = false, submit = 'Save', fields = [], onSubmit, passwordForm = false }) {
    dialogIsPassword = passwordForm;
    dialogSubmitLabel = submit;
    $('dialog-title').textContent = title;
    $('dialog-description').textContent = description;
    $('dialog-icon').replaceChildren(icon(iconName));
    $('dialog-icon').classList.toggle('is-danger', danger);
    $('dialog-submit').textContent = submit;
    $('dialog-submit').className = 'button ' + (danger ? 'danger' : 'primary');
    $('dialog-error').hidden = true;
    $('dialog-fields').replaceChildren();
    state.dialogBusy = false;
    setDialogBusy(false);
    for (const field of fields) {
      const label = element('label', '', field.label);
      label.htmlFor = 'field-' + field.name;
      const input = element('input');
      input.id = label.htmlFor;
      input.name = field.name;
      input.type = field.type || 'text';
      input.value = field.value || '';
      input.required = true;
      if (field.autocomplete) input.autocomplete = field.autocomplete;
      if (field.minLength) input.minLength = field.minLength;
      if (field.maxLength) input.maxLength = field.maxLength;
      $('dialog-fields').append(label, input);
      if (field.hint) {
        const hint = element('p', 'field-hint', field.hint);
        hint.id = input.id + '-hint';
        input.setAttribute('aria-describedby', hint.id);
        $('dialog-fields').append(hint);
      }
    }
    dialogSubmit = onSubmit;
    $('form-dialog').showModal();
    updateAuthControls();
    const input = $('dialog-fields').querySelector('input');
    if (input) { input.focus(); input.select(); } else $('dialog-cancel').focus();
  }

  function setDialogBusy(busy) {
    state.dialogBusy = busy;
    for (const id of ['dialog-submit', 'dialog-cancel', 'dialog-close']) $(id).disabled = busy;
    $('dialog-form').setAttribute('aria-busy', String(busy));
    $('dialog-fields').querySelectorAll('input').forEach(input => { input.disabled = busy; });
    updateAuthControls();
  }

  function newFolder() {
    const parent = uploadParent();
    openDialog({ title: 'A new place for your files.', description: 'Create a folder in ' + destinationName() + '.', iconName: 'folder', submit: 'Create folder', fields: [{ name: 'name', label: 'Folder name', maxLength: 255, autocomplete: 'off' }], onSubmit: async values => {
      const name = values.name.trim();
      if (!name) throw new Error('Give your folder a name first.');
      await api('/api/folders', { method: 'POST', body: { parent, name } });
      toast('Folder created.');
      if (isGlobal()) navigate(parent); else await loadFiles();
    } });
  }

  function renameItem(item) {
    openDialog({ title: 'Give it a new name.', description: 'Rename “' + item.name + '”.', iconName: 'edit', submit: 'Save name', fields: [{ name: 'name', label: item.kind === 'folder' ? 'Folder name' : 'File name', value: item.name, maxLength: 255, autocomplete: 'off', hint: item.kind === 'file' ? 'Keep the file extension so your other apps can recognize this file.' : '' }], onSubmit: async values => {
      const name = values.name.trim();
      if (!name) throw new Error('The name can’t be empty.');
      await api('/api/files/' + encodeURIComponent(item.id), { method: 'PATCH', body: { name } });
      toast('Name updated.');
      await loadFiles();
    } });
  }

  function deleteItem(item) {
    openDialog({ title: item.kind === 'folder' ? 'Delete this folder?' : 'Delete this file?', description: 'Permanently delete “' + item.name + '”' + (item.kind === 'folder' ? ', including every file and subfolder inside' : '') + '? This cannot be undone.', iconName: 'trash', danger: true, submit: 'Delete permanently', onSubmit: async () => {
      await api('/api/files/' + encodeURIComponent(item.id), { method: 'DELETE' });
      toast(item.kind === 'folder' ? 'Folder and its contents deleted.' : 'File deleted.');
      await loadFiles();
    } });
  }

  function changePassword() {
    $('account-menu').open = false;
    openDialog({ title: 'Change your password.', description: 'You’ll be signed out on every device after saving your new password.', iconName: 'lock', submit: 'Update password', passwordForm: true, fields: [
      { name: 'currentPassword', label: 'Current password', type: 'password', autocomplete: 'current-password' },
      { name: 'newPassword', label: 'New password', type: 'password', autocomplete: 'new-password', minLength: 15, maxLength: 128, hint: 'Use 15–128 characters. A longer, unique passphrase works well.' },
      { name: 'confirmPassword', label: 'Confirm new password', type: 'password', autocomplete: 'new-password', minLength: 15, maxLength: 128 }
    ], onSubmit: async values => {
      if (values.newPassword !== values.confirmPassword) throw new Error('The new passwords don’t match.');
      await api('/api/password', { method: 'POST', body: { currentPassword: values.currentPassword, newPassword: values.newPassword } });
      pauseUploads('Your password changed. Sign in, then retry this upload.');
      showLogin('Password updated. Sign in with your new password.');
      toast('Your password has been updated.');
    } });
  }

  function cleanPreview() {
    previewGeneration++;
    if (previewCleanup) { try { previewCleanup(); } catch { /* Closing a preview must always release the UI. */ } }
    previewCleanup = null;
    $('preview-content').querySelectorAll('video,audio').forEach(media => { media.pause(); media.removeAttribute('src'); media.load(); });
    $('preview-content').replaceChildren();
    $('preview-content').classList.remove('document-preview-host');
  }

  function openPreview(item) {
    cleanPreview();
    const generation = previewGeneration;
    const kind = classify(item);
    $('preview-title').textContent = item.name;
    $('preview-meta').textContent = fileKindLabels[kind] + ' · ' + bytes(item.size) + ' · ' + date(item.updatedAt);
    $('preview-file-icon').className = 'file-type-icon preview-type-icon kind-' + kind;
    $('preview-file-icon').replaceChildren(fileIcon(kind));
    $('preview-download').href = contentUrl(item, true);
    $('preview-download').download = item.name;
    $('preview-error').hidden = true;
    const holder = $('preview-content');
    holder.replaceChildren();
    const mediaError = () => {
      $('preview-error').textContent = kind === 'image' ? 'This image couldn’t be displayed. Download it to open it on your device.' : 'Your browser may not support this media format or codec, or the file could not be loaded. Download it to play it on your device.';
      $('preview-error').hidden = false;
    };
    if (kind === 'image') {
      const image = element('img');
      image.alt = item.name;
      image.addEventListener('error', mediaError, { once: true });
      image.src = contentUrl(item);
      holder.append(image);
    } else if (kind === 'video' || kind === 'audio') {
      const media = element(kind);
      media.controls = true;
      media.preload = 'metadata';
      media.setAttribute('aria-label', item.name);
      if (kind === 'video') media.playsInline = true;
      media.addEventListener('error', mediaError, { once: true });
      media.src = contentUrl(item);
      if (kind === 'audio') {
        const wrap = element('div', 'audio-preview');
        const art = element('div', 'audio-art');
        art.append(icon('audio'));
        wrap.append(art, media);
        holder.append(wrap);
      } else holder.append(media);
    } else if (canPreviewDocument(item)) {
      holder.classList.add('document-preview-host');
      const loading = element('div', 'document-loading');
      loading.append(element('span', 'spinner'), element('span', '', 'Opening your document…'));
      holder.append(loading);
      import('/document-preview.js').then(module => {
        if (generation !== previewGeneration || !$('preview-dialog').open || !state.user) return;
        holder.replaceChildren();
        previewCleanup = module.mountDocumentPreview({ item, holder, onUnauthorized: () => { if (generation === previewGeneration) expireSession(); } });
      }).catch(() => {
        if (generation !== previewGeneration || !$('preview-dialog').open || !state.user) return;
        holder.replaceChildren(element('p', 'document-loading', 'The document preview could not be loaded. Download this file to open it on your device.'));
      });
    } else {
      const fallback = element('div', 'unsupported-preview');
      const fallbackIcon = element('span', 'file-type-icon preview-fallback-icon kind-' + kind);
      fallbackIcon.append(fileIcon(kind));
      fallback.append(fallbackIcon, element('h3', '', 'This one is ready to download.'), element('p', '', 'A browser preview isn’t available for this file type. Use Download to open it in your favorite app.'));
      holder.append(fallback);
    }
    $('preview-dialog').showModal();
    $('preview-close').focus();
  }

  function setAdminBusy(busy) {
    adminBusy = busy;
    $('admin-close').disabled = busy;
    $('admin-dialog').setAttribute('aria-busy', String(busy));
    $('admin-content').querySelectorAll('input,select,button').forEach(control => { control.disabled = busy; });
  }

  function setAdminError(message, storage = false) {
    const target = $(storage ? 'admin-storage-error' : 'admin-error');
    target.textContent = message;
    target.hidden = !message;
  }

  function updateLocationDetail() {
    const location = adminData?.storage.locations.find(entry => entry.id === $('admin-storage-location').value);
    $('admin-location-path').textContent = location?.path || '';
    $('admin-location-usage').textContent = location ? bytes(location.usedBytes) + ' · ' + location.fileCount + (location.fileCount === 1 ? ' file stored here' : ' files stored here') : '';
  }

  function adminDraft() {
    return { quota: $('admin-quota').value, upload: $('admin-upload').value, unit: $('admin-upload-unit').value, concurrent: $('admin-concurrency').value, hours: $('admin-session-hours').value };
  }

  function renderAdmin(data, preservedDraft = null) {
    adminData = data;
    const settings = data.settings;
    state.limits.maxUploadBytes = settings.maxUploadBytes;
    state.limits.maxStorageBytes = settings.maxStorageBytes;
    state.limits.maxConcurrentUploads = settings.maxConcurrentUploads;
    $('upload-limit').textContent = 'Up to ' + bytes(settings.maxUploadBytes) + ' per file';
    $('admin-quota').value = String(settings.maxStorageBytes / 1073741824);
    $('admin-quota').max = '1048576';
    $('admin-quota').min = String(1 / 1073741824);
    adminUploadUnit = settings.maxUploadBytes < 1073741824 ? 1048576 : 1073741824;
    $('admin-upload-unit').value = String(adminUploadUnit);
    $('admin-upload').value = String(settings.maxUploadBytes / adminUploadUnit);
    $('admin-upload').max = String(1099511627776 / adminUploadUnit);
    $('admin-upload').min = String(1 / adminUploadUnit);
    $('admin-concurrency').value = String(settings.maxConcurrentUploads);
    $('admin-concurrency').max = '64';
    $('admin-session-hours').value = String(settings.sessionHours);
    $('admin-session-hours').max = '720';
    if (preservedDraft) {
      $('admin-quota').value = preservedDraft.quota;
      $('admin-upload').value = preservedDraft.upload;
      $('admin-upload-unit').value = preservedDraft.unit;
      adminUploadUnit = Number(preservedDraft.unit);
      $('admin-upload').max = String(1099511627776 / adminUploadUnit);
      $('admin-upload').min = String(1 / adminUploadUnit);
      $('admin-concurrency').value = preservedDraft.concurrent;
      $('admin-session-hours').value = preservedDraft.hours;
    }
    $('admin-usage').textContent = bytes(data.storage.usedBytes) + ' in use' + (data.storage.reservedBytes ? ' + ' + bytes(data.storage.reservedBytes) + ' reserved by uploads' : '') + '. 1 GiB = 1,024 MiB.';
    $('admin-storage-root').textContent = data.storage.root;
    $('admin-data-dir').textContent = data.deployment.dataDir;
    $('admin-storage-location').replaceChildren();
    for (const location of data.storage.locations) {
      const option = element('option', '', location.label + ' · ' + bytes(location.usedBytes));
      option.value = location.id;
      $('admin-storage-location').append(option);
    }
    $('admin-storage-location').value = settings.activeStorageId;
    updateLocationDetail();
    $('admin-content').hidden = false;
    $('admin-loading').hidden = true;
  }

  async function loadAdmin() {
    adminController?.abort();
    adminController = new AbortController();
    const generation = ++adminGeneration;
    $('admin-loading').hidden = false;
    $('admin-content').hidden = true;
    $('admin-retry').hidden = true;
    setAdminError('');
    try {
      const result = await api('/api/admin/settings', { signal: adminController.signal });
      if (generation !== adminGeneration || !$('admin-dialog').open || !state.user) return;
      renderAdmin(result);
    } catch (error) {
      if (error.name === 'AbortError' || generation !== adminGeneration || !state.user) return;
      $('admin-loading').hidden = true;
      setAdminError(error.message);
      $('admin-retry').hidden = error.status === 403;
    }
  }

  function openAdmin() {
    if (state.user?.role !== 'admin') return;
    $('account-menu').open = false;
    closeSidebar();
    setAdminBusy(false);
    setAdminError('', true);
    $('admin-save-status').textContent = '';
    $('admin-storage-status').textContent = '';
    $('admin-storage-name').value = '';
    $('admin-dialog').showModal();
    $('admin-close').focus();
    loadAdmin();
  }

  function byteSetting(id, multiplier, max, label) {
    const value = Number($(id).value) * multiplier;
    const rounded = Math.round(value);
    if (!Number.isFinite(value) || !Number.isSafeInteger(rounded) || rounded < 1 || rounded > max) throw new Error(label + ' must be greater than zero and no more than ' + bytes(max) + '.');
    return rounded;
  }

  async function saveAdmin(event) {
    event.preventDefault();
    if (adminBusy || !adminData) return;
    setAdminError('');
    $('admin-save-status').textContent = '';
    const generation = adminGeneration;
    try {
      const payload = {
        maxStorageBytes: byteSetting('admin-quota', 1073741824, 1125899906842624, 'Storage allowance'),
        maxUploadBytes: byteSetting('admin-upload', Number($('admin-upload-unit').value), 1099511627776, 'Maximum file size'),
        maxConcurrentUploads: Number($('admin-concurrency').value),
        sessionHours: Number($('admin-session-hours').value),
        activeStorageId: $('admin-storage-location').value
      };
      if (!Number.isInteger(payload.maxConcurrentUploads) || payload.maxConcurrentUploads < 1 || payload.maxConcurrentUploads > 64) throw new Error('Concurrent uploads must be a whole number from 1 to 64.');
      if (!Number.isInteger(payload.sessionHours) || payload.sessionHours < 1 || payload.sessionHours > 720) throw new Error('Session lifetime must be a whole number from 1 to 720 hours.');
      setAdminBusy(true);
      $('admin-save').replaceChildren(element('span', 'spinner'), document.createTextNode('Saving…'));
      const result = await api('/api/admin/settings', { method: 'PATCH', body: payload });
      if (generation !== adminGeneration || !state.user) return;
      renderAdmin(result);
      $('admin-save-status').textContent = 'Your settings are saved.';
      loadFiles();
    } catch (error) {
      if (generation === adminGeneration && state.user) { setAdminError(error.message); $('admin-error').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    } finally {
      setAdminBusy(false);
      $('admin-save').replaceChildren(icon('check'), document.createTextNode('Save settings'));
    }
  }

  async function addStorage(event) {
    event.preventDefault();
    if (adminBusy || !adminData) return;
    setAdminError('', true);
    $('admin-storage-status').textContent = '';
    const generation = adminGeneration;
    const name = $('admin-storage-name').value;
    if (!/^[A-Za-z0-9 ._-]{1,64}$/.test(name) || name.trim() !== name || name === '.' || name === '..' || name.endsWith('.')) {
      setAdminError('Use a single folder name with 1–64 letters, numbers, spaces, dots, hyphens, or underscores. Don’t start or end with spaces, or end with a dot.', true);
      return;
    }
    const draft = adminDraft();
    try {
      setAdminBusy(true);
      $('admin-add-storage').textContent = 'Creating…';
      const result = await api('/api/admin/storage', { method: 'POST', body: { name } });
      if (generation !== adminGeneration || !state.user) return;
      renderAdmin(result, draft);
      $('admin-storage-name').value = '';
      $('admin-storage-status').textContent = '“' + name + '” is now the active location for new uploads.';
      $('admin-save-status').textContent = 'Any edits to limits still need to be saved.';
      loadFiles();
    } catch (error) {
      if (generation === adminGeneration && state.user) setAdminError(error.message, true);
    } finally {
      setAdminBusy(false);
      $('admin-add-storage').replaceChildren(icon('plus'), document.createTextNode('Create & use'));
    }
  }

  function pauseUploads(message) {
    for (const upload of state.uploads) {
      if (upload.status === 'queued' || upload.status === 'uploading') {
        upload.status = 'failed';
        upload.error = message;
        upload.xhr?.abort();
      }
    }
    renderUploads();
  }

  function addFiles(files) {
    if (!state.user || !files.length) return;
    const parent = uploadParent();
    for (const file of files) {
      const tooLarge = file.size > state.limits.maxUploadBytes;
      state.uploads.push({ id: ++uploadSequence, file, parent, destination: destinationName(), progress: 0, status: tooLarge ? 'failed' : 'queued', error: tooLarge ? 'This file exceeds the ' + bytes(state.limits.maxUploadBytes) + ' upload limit.' : '', xhr: null });
    }
    $('upload-list').hidden = false;
    $('toggle-uploads').setAttribute('aria-expanded', 'true');
    renderUploads();
    pumpUploads();
  }

  function renderUploads() {
    const focused = $('upload-list').contains(document.activeElement) ? { id: document.activeElement.dataset.uploadId, action: document.activeElement.dataset.uploadAction } : null;
    $('upload-tray').hidden = !state.uploads.length;
    const running = state.uploads.filter(upload => upload.status === 'queued' || upload.status === 'uploading').length;
    const completed = state.uploads.filter(upload => upload.status === 'complete').length;
    const failed = state.uploads.filter(upload => upload.status === 'failed').length;
    $('uploads-summary').textContent = running ? 'Uploading · ' + completed + ' of ' + state.uploads.length + ' complete' : failed ? 'Uploads · ' + failed + ' need attention' : completed ? completed + (completed === 1 ? ' upload complete' : ' uploads complete') : 'Uploads canceled';
    const holder = $('upload-list');
    holder.replaceChildren();
    for (const upload of state.uploads) {
      const kind = classify(upload.file);
      const row = element('div', 'upload-row kind-' + kind);
      const top = element('div', 'upload-row-top');
      top.append(fileIcon(kind));
      const name = element('span', 'upload-row-name', upload.file.name);
      name.title = fileKindLabels[kind] + ' · ' + upload.file.name;
      top.append(name);
      if (upload.status === 'queued' || upload.status === 'uploading') {
        const cancel = menuAction('', 'close', () => {
          upload.status = 'canceled';
          upload.xhr?.abort();
          renderUploads();
          pumpUploads();
        }, 'icon-button');
        cancel.setAttribute('aria-label', 'Cancel upload of ' + upload.file.name);
        cancel.title = 'Cancel upload';
        cancel.dataset.uploadId = upload.id;
        cancel.dataset.uploadAction = 'cancel';
        top.append(cancel);
      } else if (upload.status === 'failed' || upload.status === 'canceled') {
        const retry = menuAction('', 'refresh', () => {
          if (!state.user) return toast('Sign in before retrying an upload.', true);
          if (upload.file.size > state.limits.maxUploadBytes) return toast('This file exceeds the current upload limit.', true);
          upload.status = 'queued'; upload.progress = 0; upload.error = '';
          renderUploads(); pumpUploads();
        }, 'icon-button');
        retry.setAttribute('aria-label', 'Retry upload of ' + upload.file.name);
        retry.title = 'Retry upload';
        retry.dataset.uploadId = upload.id;
        retry.dataset.uploadAction = 'retry';
        top.append(retry);
      } else {
        const check = icon('check');
        check.classList.add('upload-complete');
        top.append(check);
      }
      row.append(top);
      if (upload.status === 'uploading') {
        const progress = element('progress');
        progress.max = 100;
        progress.value = upload.progress;
        progress.setAttribute('aria-label', 'Upload progress for ' + upload.file.name);
        row.append(progress);
      }
      const status = upload.status === 'failed' ? upload.error : upload.status === 'canceled' ? 'Canceled · choose retry to try again' : upload.status === 'complete' ? bytes(upload.file.size) + ' · Saved to ' + upload.destination : upload.status === 'queued' ? 'Waiting · ' + bytes(upload.file.size) + ' · ' + upload.destination : upload.progress >= 100 ? 'Finishing upload…' : Math.round(upload.progress) + '% · ' + bytes(upload.file.size) + ' · ' + upload.destination;
      row.append(element('div', 'upload-row-status' + (upload.status === 'failed' ? ' upload-failed' : ''), status));
      holder.append(row);
    }
    if (focused?.id) {
      const next = holder.querySelector('[data-upload-id="' + focused.id + '"][data-upload-action="' + focused.action + '"]');
      (next || $('toggle-uploads')).focus({ preventScroll: true });
    }
  }

  async function pumpUploads() {
    if (state.uploading || !state.user) return;
    const upload = state.uploads.find(entry => entry.status === 'queued');
    if (!upload) return;
    state.uploading = true;
    upload.status = 'uploading';
    renderUploads();
    try {
      await sendUpload(upload);
      if (upload.status === 'uploading') upload.status = 'complete';
    } catch (error) {
      if (upload.status === 'uploading') {
        upload.status = 'failed';
        upload.error = error.message;
      }
    } finally {
      upload.xhr = null;
      state.uploading = false;
      renderUploads();
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => { if (state.user) loadFiles(); }, 250);
      pumpUploads();
    }
  }

  function sendUpload(upload, canRecoverCsrf = true) {
    return new Promise((resolve, reject) => {
      const requestEpoch = authEpoch;
      const requestCsrf = state.csrf;
      const xhr = new XMLHttpRequest();
      upload.xhr = xhr;
      const params = new URLSearchParams({ parent: upload.parent, name: upload.file.name });
      xhr.open('PUT', '/api/upload?' + params);
      xhr.setRequestHeader('X-CSRF-Token', state.csrf);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      let lastRender = 0;
      xhr.upload.addEventListener('progress', event => {
        if (upload.status !== 'uploading') return;
        upload.progress = event.lengthComputable ? event.loaded / event.total * 100 : 0;
        if (Date.now() - lastRender > 160 || upload.progress >= 100) { renderUploads(); lastRender = Date.now(); }
      });
      xhr.addEventListener('load', async () => {
        if (xhr.status >= 200 && xhr.status < 300) { upload.progress = 100; resolve(); return; }
        let message = 'Upload failed. Please retry.';
        try { message = JSON.parse(xhr.responseText).error || message; } catch { if (xhr.status === 413) message = 'This file exceeds the server or proxy upload limit.'; }
        if (canRecoverCsrf && xhr.status === 403 && message === csrfErrorMessage) {
          try {
            if (await recoverCsrf(requestCsrf, requestEpoch) && upload.status === 'uploading') {
              upload.progress = 0;
              resolve(await sendUpload(upload, false));
              return;
            }
          } catch (error) { reject(error); return; }
        }
        if (xhr.status === 401 && requestEpoch === authEpoch) expireSession();
        reject(new Error(message));
      });
      xhr.addEventListener('error', () => reject(new Error('Connection lost. Retry when your server is reachable.')));
      xhr.addEventListener('abort', () => reject(new Error('Upload canceled.')));
      xhr.addEventListener('timeout', () => reject(new Error('Upload timed out. Please retry.')));
      xhr.send(upload.file);
    });
  }

  $('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (loginBusy || authCooldownUntil > Date.now()) return;
    loginBusy = true;
    updateAuthControls();
    setLoginMessage('');
    try {
      const session = await api('/api/login', { method: 'POST', body: { username: $('username').value.trim(), password: $('password').value } });
      await showApp(session);
    } catch (error) {
      honorAuthCooldown(error);
      setLoginMessage(authErrorMessage(error));
      $('password').focus();
    } finally {
      loginBusy = false;
      updateAuthControls();
    }
  });
  $('show-password').addEventListener('click', () => {
    const show = $('password').type === 'password';
    $('password').type = show ? 'text' : 'password';
    $('show-password').textContent = show ? 'Hide' : 'Show';
    $('show-password').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    $('show-password').setAttribute('aria-pressed', String(show));
  });
  $('logout').addEventListener('click', async () => {
    $('logout').disabled = true;
    try {
      await api('/api/logout', { method: 'POST' });
      pauseUploads('You signed out. Sign in, then retry this upload.');
      showLogin();
    } catch (error) { toast(error.message, true); }
    finally { $('logout').disabled = false; $('account-menu').open = false; }
  });
  $('admin-settings').addEventListener('click', openAdmin);
  $('admin-close').addEventListener('click', () => { if (!adminBusy) $('admin-dialog').close(); });
  $('admin-dialog').addEventListener('cancel', event => { if (adminBusy) event.preventDefault(); });
  $('admin-dialog').addEventListener('close', () => { adminController?.abort(); adminGeneration++; });
  $('admin-retry').addEventListener('click', loadAdmin);
  $('admin-form').addEventListener('submit', saveAdmin);
  $('admin-storage-form').addEventListener('submit', addStorage);
  $('admin-form').addEventListener('input', () => { $('admin-save-status').textContent = 'Unsaved changes'; });
  $('admin-storage-location').addEventListener('change', updateLocationDetail);
  $('admin-upload-unit').addEventListener('change', () => {
    const newUnit = Number($('admin-upload-unit').value);
    if ($('admin-upload').value) $('admin-upload').value = String(Number($('admin-upload').value) * adminUploadUnit / newUnit);
    adminUploadUnit = newUnit;
    $('admin-upload').max = String(1099511627776 / newUnit);
    $('admin-upload').min = String(1 / newUnit);
  });
  $('change-password').addEventListener('click', changePassword);
  $('new-folder').addEventListener('click', newFolder);
  for (const id of ['upload-button', 'browse-files']) $(id).addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', event => { addFiles(Array.from(event.target.files || [])); event.target.value = ''; });
  $('empty-action').addEventListener('click', () => state.route.q ? navigate() : $('file-input').click());
  $('retry-load').addEventListener('click', loadFiles);
  $('search').addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => navigate(state.route.parent, state.route.type, $('search').value.trim(), true), 300);
  });
  $('search').addEventListener('keydown', event => { if (event.key === 'Enter') { window.clearTimeout(searchTimer); navigate(state.route.parent, state.route.type, $('search').value.trim(), true); } });
  $('sort').addEventListener('change', () => { state.sort = $('sort').value; renderFiles(); });
  $('grid-view').addEventListener('click', () => setView('grid'));
  $('list-view').addEventListener('click', () => setView('list'));
  $('mobile-menu').addEventListener('click', () => {
    const open = !$('sidebar').classList.contains('is-open');
    $('sidebar').classList.toggle('is-open', open);
    $('sidebar').inert = !open;
    $('sidebar-shade').hidden = !open;
    $('mobile-menu').setAttribute('aria-expanded', String(open));
    $('workspace').inert = open;
    if (open) $('sidebar').querySelector('.nav-item').focus();
  });
  $('sidebar-shade').addEventListener('click', closeSidebar);
  $('sidebar').querySelectorAll('a[href]').forEach(link => link.addEventListener('click', closeSidebar));
  window.matchMedia('(max-width: 700px)').addEventListener('change', closeSidebar);
  window.addEventListener('hashchange', readRoute);
  document.addEventListener('click', event => {
    document.querySelectorAll('.file-menu[open], .account-menu[open]').forEach(menu => { if (!menu.contains(event.target)) menu.open = false; });
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Tab' && $('sidebar').classList.contains('is-open') && !$('form-dialog').open && !$('admin-dialog').open) {
      const focusable = Array.from($('sidebar').querySelectorAll('a,button,summary')).filter(node => !node.disabled && node.getClientRects().length);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    if (event.key === 'Escape') {
      if ($('sidebar').classList.contains('is-open')) { closeSidebar(); $('mobile-menu').focus(); }
      document.querySelectorAll('.file-menu[open], .account-menu[open]').forEach(menu => { menu.open = false; menu.querySelector('summary').focus(); });
    }
  });
  for (const id of ['dialog-close', 'dialog-cancel']) $(id).addEventListener('click', () => { if (!state.dialogBusy) $('form-dialog').close(); });
  $('form-dialog').addEventListener('cancel', event => { if (state.dialogBusy) event.preventDefault(); });
  $('form-dialog').addEventListener('close', () => { $('dialog-fields').replaceChildren(); dialogSubmit = null; dialogIsPassword = false; updateAuthControls(); });
  $('dialog-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (state.dialogBusy || !dialogSubmit || (dialogIsPassword && authCooldownUntil > Date.now())) return;
    const values = Object.fromEntries(new FormData($('dialog-form')));
    const originalLabel = $('dialog-submit').textContent;
    setDialogBusy(true);
    $('dialog-submit').textContent = 'Working…';
    $('dialog-error').hidden = true;
    try {
      await dialogSubmit(values);
      $('form-dialog').close();
    } catch (error) {
      if (dialogIsPassword) honorAuthCooldown(error);
      $('dialog-error').textContent = dialogIsPassword ? authErrorMessage(error) : error.message;
      $('dialog-error').hidden = false;
    } finally {
      setDialogBusy(false);
      $('dialog-submit').textContent = originalLabel;
      updateAuthControls();
    }
  });
  $('preview-close').addEventListener('click', () => $('preview-dialog').close());
  $('preview-dialog').addEventListener('close', cleanPreview);
  $('preview-dialog').addEventListener('click', event => { if (event.target === $('preview-dialog')) { const bounds = $('preview-dialog').getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) $('preview-dialog').close(); } });
  $('toggle-uploads').addEventListener('click', () => { const expanded = $('toggle-uploads').getAttribute('aria-expanded') === 'true'; $('toggle-uploads').setAttribute('aria-expanded', String(!expanded)); $('upload-list').hidden = expanded; });
  $('clear-uploads').addEventListener('click', () => {
    const active = state.uploads.filter(upload => upload.status === 'queued' || upload.status === 'uploading');
    if (active.length === state.uploads.length) { $('upload-list').hidden = true; $('toggle-uploads').setAttribute('aria-expanded', 'false'); }
    state.uploads = active;
    renderUploads();
  });
  const fileDrag = event => Array.from(event.dataTransfer?.types || []).includes('Files');
  document.addEventListener('dragenter', event => { if (fileDrag(event)) { event.preventDefault(); if (state.user && !$('form-dialog').open && !$('preview-dialog').open && !$('admin-dialog').open) { dragDepth++; $('drag-overlay').hidden = false; } } });
  document.addEventListener('dragover', event => { if (fileDrag(event)) { event.preventDefault(); event.dataTransfer.dropEffect = state.user ? 'copy' : 'none'; } });
  document.addEventListener('dragleave', event => { if (fileDrag(event)) { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('drag-overlay').hidden = true; } });
  document.addEventListener('drop', event => {
    if (!fileDrag(event)) return;
    event.preventDefault();
    dragDepth = 0;
    $('drag-overlay').hidden = true;
    if (!state.user || $('form-dialog').open || $('preview-dialog').open || $('admin-dialog').open) return;
    let files = Array.from(event.dataTransfer.files || []);
    if (event.dataTransfer.items?.length) {
      const items = Array.from(event.dataTransfer.items).filter(item => item.kind === 'file');
      if (items.some(item => item.webkitGetAsEntry?.()?.isDirectory)) {
        toast('Folder uploads aren’t supported yet. Create a folder here, then drop its files inside.', true);
        files = items.filter(item => !item.webkitGetAsEntry?.()?.isDirectory).map(item => item.getAsFile()).filter(Boolean);
      }
    }
    addFiles(files);
  });
  window.addEventListener('blur', () => { dragDepth = 0; $('drag-overlay').hidden = true; });
  window.addEventListener('beforeunload', event => { if (state.uploads.some(upload => upload.status === 'queued' || upload.status === 'uploading')) { event.preventDefault(); event.returnValue = ''; } });

  try { if (localStorage.getItem('harbor-view') === 'list') setView('list'); } catch { /* View preference is optional. */ }
  closeSidebar();
  api('/api/session').then(showApp).catch(error => showLogin(error.status === 401 ? '' : error.message));
})();
