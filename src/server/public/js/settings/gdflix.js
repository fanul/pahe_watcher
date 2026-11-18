import { api } from '../state.js';

let currentCookiesObj = {};
let editingDomain = null;
let savedCookiesSnapshot = '';

function updateSavedStatus(form) {
  const el = document.getElementById('gdflixSavedStatus');
  if (!el) return;

  const currentVal = form.gdflixCookies?.value || '';
  const hasUnsaved = currentVal !== savedCookiesSnapshot;
  const domains = Object.keys(currentCookiesObj);

  if (hasUnsaved) {
    el.innerHTML = `<span style="color: var(--amber);">● Perubahan belum disimpan (${domains.length} domain di daftar) — klik <b>Save</b> di bawah untuk menyimpan.</span>`;
    return;
  }

  if (!savedCookiesSnapshot.trim() || domains.length === 0) {
    el.innerHTML = '<span style="color: #8b949e;">○ Belum ada cookies tersimpan di config.</span>';
    return;
  }

  const labels = domains.map((d) => (d === '*' ? 'default' : d));
  const preview = labels.slice(0, 3).join(', ') + (labels.length > 3 ? `, +${labels.length - 3}` : '');
  el.innerHTML = `<span style="color: #3fb950;">✓ Tersimpan di config: ${domains.length} domain (${preview})</span>`;
}

export function markGdflixCookiesSaved(form) {
  savedCookiesSnapshot = form.gdflixCookies?.value || '';
  updateSavedStatus(form);
}

export function initGdflixSettings(form) {
  const btnAdd = document.getElementById('btnAddGdflixCookie');
  const btnCancel = document.getElementById('btnCancelGdflixCookie');
  const btnApply = document.getElementById('btnApplyGdflixCookie');
  const btnExtract = document.getElementById('btnExtractGdflixCookies');
  const btnTestLogin = document.getElementById('btnTestGdflixLogin');
  const extractStatus = document.getElementById('gdflixExtractStatus');
  const editor = document.getElementById('gdflixCookieEditor');
  const txtDomain = document.getElementById('gdflixCookieDomain');
  const txtValue = document.getElementById('gdflixCookieValue');
  const title = document.getElementById('gdflixEditorTitle');

  if (btnExtract) {
    btnExtract.addEventListener('click', async () => {
      if (extractStatus) extractStatus.textContent = 'Mengambil cookies GDFlix dari browser…';
      try {
        const res = await api('/browser/gdflix-cookies');
        const domains = Object.keys(res.byDomain || {});
        if (!res.count || domains.length === 0) {
          if (extractStatus) {
            extractStatus.innerHTML = '<span style="color: var(--amber);">Belum ada cookies GDFlix di browser. Login dulu via "Buka halaman login GDFlix", lalu klik lagi.</span>';
          }
          return;
        }
        let latestCookies = null;
        for (const domain of domains) {
          const serialized = JSON.stringify(res.byDomain[domain]);
          currentCookiesObj[domain] = serialized;
          latestCookies = serialized;
        }
        if (latestCookies && !currentCookiesObj['*']) {
          currentCookiesObj['*'] = latestCookies;
        }
        saveToTextarea(form);
        renderCookieList(form);
        if (extractStatus) {
          extractStatus.innerHTML = `<span style="color: #3fb950;">✓ Berhasil mengambil ${res.count} cookie dari ${domains.join(', ')}. Klik Save untuk menyimpan.</span>`;
        }
      } catch (err) {
        if (extractStatus) {
          extractStatus.innerHTML = `<span style="color: var(--danger, #f85149);">❌ Gagal mengambil cookies: ${err.message}</span>`;
        }
      }
    });
  }

  if (btnTestLogin) {
    btnTestLogin.addEventListener('click', async () => {
      if (extractStatus) extractStatus.textContent = 'Menguji login GDFlix di browser…';
      try {
        const loginUrl = (document.getElementById('gdflixLoginUrl')?.value || '').trim() || 'https://new4.gdflix.io/login';
        const res = await api('/browser/gdflix-test', {
          method: 'POST',
          body: JSON.stringify({
            url: loginUrl,
            cookies: form.gdflixCookies?.value || '',
            email: form.gdflixEmail?.value || '',
            password: form.gdflixPassword?.value || '',
          }),
        });
        if (res.ok) {
          const methodLabel = res.method === 'cookies'
            ? 'via cookies'
            : res.method === 'session'
              ? 'via sesi browser'
              : res.method === 'credentials'
                ? 'via email/password'
                : (res.method || 'aktif');
          if (extractStatus) {
            extractStatus.innerHTML = `<span style="color: #3fb950;">✓ GDFlix siap dipakai! Terautentikasi di <b>${res.domain || 'gdflix'}</b> (${methodLabel}).</span>`;
          }
        } else {
          if (extractStatus) {
            extractStatus.innerHTML = `<span style="color: var(--danger, #f85149);">❌ Belum terautentikasi di <b>${res.domain || 'gdflix'}</b> — silakan login lewat "Buka halaman login GDFlix" atau perbarui cookies.</span>`;
          }
        }
      } catch (err) {
        if (extractStatus) {
          extractStatus.innerHTML = `<span style="color: var(--danger, #f85149);">❌ Gagal menguji login GDFlix: ${err.message}</span>`;
        }
      }
    });
  }

  if (!btnAdd || !btnCancel || !btnApply) return;

  btnAdd.addEventListener('click', () => {
    editingDomain = null;
    title.textContent = 'Add Domain Cookies';
    txtDomain.value = '';
    txtDomain.removeAttribute('readonly');
    txtValue.value = '';
    editor.style.display = 'block';
    txtDomain.focus();
  });

  btnCancel.addEventListener('click', () => {
    editor.style.display = 'none';
  });

  btnApply.addEventListener('click', () => {
    let domain = txtDomain.value.trim().toLowerCase();
    const value = txtValue.value.trim();
    
    if (!domain) {
      alert('Please enter a domain name (or * for default).');
      return;
    }
    
    // Normalize domain
    if (domain !== '*') {
      // Strip http/https/www
      domain = domain.replace(/^(https?:\/\/)?(www\.)?/, '');
      // Keep only host
      domain = domain.split('/')[0];
    }
    
    if (!value) {
      alert('Please enter cookie value(s).');
      return;
    }

    if (editingDomain && editingDomain !== domain) {
      delete currentCookiesObj[editingDomain];
    }

    currentCookiesObj[domain] = value;
    saveToTextarea(form);
    renderCookieList(form);
    editor.style.display = 'none';
  });
}

function saveToTextarea(form) {
  const keys = Object.keys(currentCookiesObj);
  if (keys.length === 0) {
    form.gdflixCookies.value = '';
  } else if (keys.length === 1 && keys[0] === '*') {
    // Save plain text directly if only '*' exists, for backward compatibility
    form.gdflixCookies.value = currentCookiesObj['*'];
  } else {
    form.gdflixCookies.value = JSON.stringify(currentCookiesObj, null, 2);
  }
  updateSavedStatus(form);
}

export function populateGdflixSettings(form, cfg) {
  form.gdflixEmail.value = cfg.bypass.gdflixEmail || '';
  form.gdflixPassword.value = cfg.bypass.gdflixPassword || '';
  
  const rawCookies = cfg.bypass.gdflixCookies || '';
  form.gdflixCookies.value = rawCookies;
  savedCookiesSnapshot = rawCookies;
  
  currentCookiesObj = {};
  if (rawCookies.trim()) {
    if (rawCookies.trim().startsWith('{')) {
      try {
        currentCookiesObj = JSON.parse(rawCookies);
      } catch {
        currentCookiesObj = { '*': rawCookies };
      }
    } else {
      currentCookiesObj = { '*': rawCookies };
    }
  }

  // Hide editor on open
  const editor = document.getElementById('gdflixCookieEditor');
  if (editor) editor.style.display = 'none';
  const extractStatus = document.getElementById('gdflixExtractStatus');
  if (extractStatus) extractStatus.textContent = '';

  renderCookieList(form);
  updateSavedStatus(form);
}

export function serializeGdflixSettings(form) {
  return {
    email: form.gdflixEmail.value,
    password: form.gdflixPassword.value,
    cookies: form.gdflixCookies.value,
  };
}

function renderCookieList(form) {
  const list = document.getElementById('gdflixCookieList');
  const empty = document.getElementById('gdflixNoCookies');
  if (!list || !empty) return;

  list.innerHTML = '';
  const domains = Object.keys(currentCookiesObj);

  if (domains.length === 0) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  domains.forEach(domain => {
    const value = currentCookiesObj[domain];
    const isJson = value.trim().startsWith('[');
    
    let detailText = 'Cookie String';
    if (isJson) {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
          const names = parsed.map(c => c.name).filter(Boolean);
          detailText = `${names.length} cookie(s): ${names.slice(0, 2).join(', ')}${names.length > 2 ? '...' : ''}`;
        }
      } catch {
        detailText = 'Malformed JSON';
      }
    } else {
      const parts = value.split(';').map(p => p.trim()).filter(Boolean);
      detailText = `${parts.length} cookie(s)`;
    }

    const item = document.createElement('div');
    item.className = 'cookie-item';
    item.style = 'display: flex; align-items: center; justify-content: space-between; padding: 6px 8px; background: #161b22; border: 1px solid var(--border); border-radius: 4px;';
    
    const label = domain === '*' ? 'default (fallback)' : domain;
    
    item.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 2px;">
        <span style="font-size: 13px; font-weight: bold; color: #c9d1d9;">${label}</span>
        <span style="font-size: 11px; color: #8b949e;">${detailText}</span>
      </div>
      <div style="display: flex; gap: 6px;">
        <button type="button" class="btn ghost small btn-edit-cookie" data-domain="${domain}" style="padding: 2px 6px; font-size: 10px; height: auto;">Edit</button>
        <button type="button" class="btn ghost small btn-delete-cookie" data-domain="${domain}" style="padding: 2px 6px; font-size: 10px; height: auto; color: #f85149;">Delete</button>
      </div>
    `;

    // Bind edit
    item.querySelector('.btn-edit-cookie').addEventListener('click', () => {
      editingDomain = domain;
      const title = document.getElementById('gdflixEditorTitle');
      const txtDomain = document.getElementById('gdflixCookieDomain');
      const txtValue = document.getElementById('gdflixCookieValue');
      const editor = document.getElementById('gdflixCookieEditor');
      
      title.textContent = 'Edit Domain Cookies';
      txtDomain.value = domain;
      if (domain === '*') {
        txtDomain.setAttribute('readonly', 'true');
      } else {
        txtDomain.removeAttribute('readonly');
      }
      txtValue.value = currentCookiesObj[domain];
      editor.style.display = 'block';
      txtValue.focus();
    });

    // Bind delete
    item.querySelector('.btn-delete-cookie').addEventListener('click', () => {
      if (confirm(`Remove cookies for ${label}?`)) {
        delete currentCookiesObj[domain];
        saveToTextarea(form);
        renderCookieList(form);
        const editor = document.getElementById('gdflixCookieEditor');
        if (editor) editor.style.display = 'none';
      }
    });

    list.appendChild(item);
  });
}
