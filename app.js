/* ═══════════════════════════════════════════════════════════
   COUPLEGOAL — APP.JS
   Auth: Supabase Email+Password (2 akun linked via couple_id)
   Sync: Supabase Realtime
   Fitur baru: Health Score, Savings Goals, Monthly Report, Split Calc
   ═══════════════════════════════════════════════════════════

   ⚙️ SETUP — ganti 2 baris ini dengan kredensial Supabase kamu:
*/
const SUPABASE_URL = 'https://dprrjhsifjmlpvcgsgco.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRwcnJqaHNpZmptbHB2Y2dzZ2NvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgxMjk5MjIsImV4cCI6MjEwMzcwNTkyMn0.ueOlIHdT3JSCEz_It4u6qRCChn7RZv-4mTrsBXMma4A';

/* ── SUPABASE SQL SCHEMA (jalankan di Supabase SQL Editor) ──

-- Couples table
create table public.couples (
  id uuid primary key default gen_random_uuid(),
  name1 text not null,
  name2 text not null,
  email1 text not null,
  email2 text not null,
  currency text default 'Rp',
  created_at timestamptz default now()
);

-- Couple data (budget + transactions + goals + splits)
create table public.couple_data (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid references public.couples(id) on delete cascade,
  data jsonb not null default '{}',
  updated_at timestamptz default now()
);

-- Allow authenticated users to read/write their own couple data
alter table public.couples enable row level security;
alter table public.couple_data enable row level security;

create policy "Users can read own couple" on public.couples
  for select using (
    email1 = auth.jwt()->>'email' or email2 = auth.jwt()->>'email'
  );

create policy "Users can update own couple" on public.couples
  for update using (
    email1 = auth.jwt()->>'email' or email2 = auth.jwt()->>'email'
  );

create policy "Users can read own couple_data" on public.couple_data
  for all using (
    couple_id in (
      select id from public.couples
      where email1 = auth.jwt()->>'email' or email2 = auth.jwt()->>'email'
    )
  );

── END SQL SCHEMA ── */

/* ══════════════════════════════════════════
   INIT SUPABASE — diinisialisasi di DOMContentLoaded
══════════════════════════════════════════ */
let sbClient = null;

/* ══════════════════════════════════════════
   CONSTANTS
══════════════════════════════════════════ */
const CATEGORIES = [
  { key: 'income',      label: 'Pemasukan',          icon: '💼', color: '#34d399' },
  { key: 'fixed',       label: 'Pengeluaran Tetap',  icon: '🏠', color: '#f87171' },
  { key: 'variable',    label: 'Variabel',            icon: '🛍️', color: '#fbbf24' },
  { key: 'loan',        label: 'Cicilan',             icon: '💳', color: '#fb923c' },
  { key: 'savings',     label: 'Tabungan',            icon: '🐷', color: '#38bdf8' },
  { key: 'investments', label: 'Investasi',           icon: '📈', color: '#c084fc' },
];
const EXPENSE_CATEGORIES = ['fixed', 'variable', 'loan'];

/* ══════════════════════════════════════════
   STATE
══════════════════════════════════════════ */
let currentUser = null;
let currentCouple = null;
let coupleDataId = null;

let state = {
  settings: {
    name1: '', name2: '', currency: 'Rp', month: '', theme: 'dark',
  },
  budgetItems: { income: [], fixed: [], variable: [], loan: [], savings: [], investments: [] },
  transactions: [],
  goals: [],
  splitHistory: [],
};

/* ══════════════════════════════════════════
   HELPERS
══════════════════════════════════════════ */
const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function fmt(n) {
  const cur = state.settings.currency || 'Rp';
  const num = Math.abs(n || 0);
  const formatted = num >= 1_000_000
    ? (num / 1_000_000).toFixed(1).replace(/\.0$/, '') + ' jt'
    : num.toLocaleString('id-ID');
  return cur + ' ' + formatted;
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d + 'T00:00:00').toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}

function monthLabel(monthStr) {
  if (!monthStr) return '';
  const [y, m] = monthStr.split('-');
  return new Date(+y, +m - 1, 1).toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
}

function calcBudget(category, assignee) {
  return (state.budgetItems[category] || [])
    .filter(i => !assignee || i.assignee === assignee)
    .reduce((s, i) => s + (i.budget || 0), 0);
}

function calcActual(category, assignee) {
  const month = state.settings.month;
  return state.transactions.filter(t => {
    if (t.type !== category) return false;
    if (assignee && t.assignee !== assignee) return false;
    if (month && t.date && t.date.substring(0, 7) !== month) return false;
    return true;
  }).reduce((s, t) => s + (t.amount || 0), 0);
}

function calcTotalBudget(cats) { return cats.reduce((s, c) => s + calcBudget(c), 0); }
function calcTotalActual(cats) { return cats.reduce((s, c) => s + calcActual(c), 0); }

function getMonthStats() {
  const month = state.settings.month;
  if (!month) return { pct: 0, passed: 0, left: 0, total: 0 };
  const [y, m] = month.split('-').map(Number);
  const now = new Date();
  const first = new Date(y, m - 1, 1);
  const last  = new Date(y, m, 0);
  const total = last.getDate();
  let passed = 0;
  if (now >= first && now <= last) passed = now.getDate();
  else if (now > last) passed = total;
  return { pct: Math.round((passed / total) * 100), passed, left: total - passed, total };
}

function getActualForItem(cat, item) {
  const month = state.settings.month;
  return state.transactions.filter(t => {
    if (t.type !== cat) return false;
    if (month && t.date && t.date.substring(0, 7) !== month) return false;
    if (t.budgetItemId) return t.budgetItemId === item.id;
    return t.assignee === item.assignee && t.description === item.description;
  }).reduce((s, t) => s + (t.amount || 0), 0);
}

/* ══════════════════════════════════════════
   SUPABASE DATA SYNC
══════════════════════════════════════════ */
async function loadFromSupabase() {
  if (!currentCouple) return;
  const { data, error } = await sbClient
    .from('couple_data')
    .select('*')
    .eq('couple_id', currentCouple.id)
    .maybeSingle();

  if (error) { console.error('Load error:', error); return; }

  if (data) {
    coupleDataId = data.id;
    const parsed = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
    state = deepMerge(state, parsed);
    // Sync currency from couple settings
    state.settings.name1 = currentCouple.name1;
    state.settings.name2 = currentCouple.name2;
    state.settings.currency = currentCouple.currency || 'Rp';
    if (!state.settings.month) {
      const now = new Date();
      state.settings.month = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    }
  } else {
    // First time — create row
    const now = new Date();
    if (!state.settings.month)
      state.settings.month = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    state.settings.name1 = currentCouple.name1;
    state.settings.name2 = currentCouple.name2;
    state.settings.currency = currentCouple.currency || 'Rp';
    await saveToSupabase();
  }
}

async function saveToSupabase() {
  if (!currentCouple) return;
  const payload = {
    couple_id: currentCouple.id,
    data: state,
    updated_at: new Date().toISOString(),
  };
  if (coupleDataId) {
    const { error } = await sbClient.from('couple_data').update(payload).eq('id', coupleDataId);
    if (error) console.error('Save error:', error);
  } else {
    const { data, error } = await sbClient.from('couple_data').insert(payload).select().single();
    if (error) { console.error('Insert error:', error); return; }
    coupleDataId = data.id;
  }
}

// Debounced save
let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveToSupabase(), 600);
}

function deepMerge(target, source) {
  const out = { ...target };
  for (const key in source) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      out[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      out[key] = source[key];
    }
  }
  return out;
}

/* Realtime subscribe */
function subscribeRealtime() {
  if (!currentCouple) return;
  sbClient
    .channel('couple-data-' + currentCouple.id)
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'couple_data',
      filter: `couple_id=eq.${currentCouple.id}`,
    }, payload => {
      // Avoid re-applying own save
      if (payload.new && payload.new.data) {
        const parsed = typeof payload.new.data === 'string' ? JSON.parse(payload.new.data) : payload.new.data;
        state = deepMerge(state, parsed);
        renderPage(currentPage);
        updateSidebarCouple();
      }
    })
    .subscribe();
}

/* Export / Import JSON */
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `couplegoal-${state.settings.name1}-${state.settings.month || 'data'}.json`;
  a.click();
  showToast('Data berhasil diekspor ✅');
}

let pendingImportData = null;

function handleImportFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      if (!data.settings || !data.budgetItems || !data.transactions) throw new Error('Format tidak valid');
      pendingImportData = data;
      const html = `
        <div class="import-preview-item"><span class="import-preview-label">Pasangan</span><span class="import-preview-val">${data.settings.name1} & ${data.settings.name2}</span></div>
        <div class="import-preview-item"><span class="import-preview-label">Bulan</span><span class="import-preview-val">${monthLabel(data.settings.month) || '-'}</span></div>
        <div class="import-preview-item"><span class="import-preview-label">Total Transaksi</span><span class="import-preview-val">${data.transactions.length}</span></div>
      `;
      $('import-preview-content').innerHTML = html;
      $('settings-modal').classList.add('hidden');
      $('import-modal').classList.remove('hidden');
    } catch { showToast('File JSON tidak valid', 'error'); }
  };
  reader.readAsText(file);
  $('import-file').value = '';
}

/* ══════════════════════════════════════════
   AUTH
══════════════════════════════════════════ */

/* ── Tab switcher — dipanggil dari initAuth() ── */
function switchAuthTab(tabKey) {
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabKey));
  document.querySelectorAll('.auth-form-wrap').forEach(f => f.classList.remove('active'));
  const target = document.getElementById('tab-' + tabKey);
  if (target) target.classList.add('active');
}

function initAuthTabs() {
  // Gunakan event delegation di document agar tidak terpengaruh DOM timing / z-index issue
  document.addEventListener('click', e => {
    const tab = e.target.closest('.auth-tab');
    if (tab && tab.dataset.tab) {
      switchAuthTab(tab.dataset.tab);
      return;
    }
    const link = e.target.closest('.auth-switch');
    if (link && link.dataset.to) {
      e.preventDefault();
      switchAuthTab(link.dataset.to);
    }
  });
}


/* ══════════════════════════════════════════
   PASSWORD TOGGLE — global scope
══════════════════════════════════════════ */
function handleTogglePw(e) {
  const btn = e.target.closest('.toggle-pw');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const inp = $(btn.dataset.target);
  if (inp) {
    inp.type = inp.type === 'password' ? 'text' : 'password';
    btn.textContent = inp.type === 'password' ? '👁' : '🙈';
  }
}
document.addEventListener('click', handleTogglePw);
document.addEventListener('touchend', handleTogglePw, { passive: false });

function buildInviteLink(coupleId, partnerName, partnerEmail) {
  const base = window.location.href.split('?')[0].split('#')[0];
  const params = new URLSearchParams({ join: coupleId, name: partnerName, email: partnerEmail });
  return `${base}?${params.toString()}`;
}

/* ── JOIN via INVITE LINK ── */
async function checkInviteLink() {
  const params = new URLSearchParams(window.location.search);
  const coupleId = params.get('join');
  const partnerName = params.get('name');
  const partnerEmail = params.get('email');

  if (!coupleId || !partnerEmail) return false;

  // Show join screen
  $('auth-screen').classList.add('hidden');
  $('join-screen').classList.remove('hidden');
  $('join-tagline').textContent = `Kamu diundang bergabung ke CoupleGoal.`;

  $('join-btn').addEventListener('click', async () => {
    const password = $('join-password').value;
    if (password.length < 6) { showToast('Password minimal 6 karakter', 'error'); return; }

    setJoinLoading(true);
    // Sign up partner
    const { data: signupData, error } = await sbClient.auth.signUp({ email: partnerEmail, password });
    setJoinLoading(false);

    if (error) { showToast('Gagal daftar: ' + error.message, 'error'); return; }
    currentUser = signupData.user;

    // Load couple data
    const { data: couple, error: coupleErr } = await sbClient
      .from('couples').select('*').eq('id', coupleId).single();
    if (coupleErr || !couple) { showToast('Undangan tidak valid', 'error'); return; }

    currentCouple = couple;
    // Clear invite params from URL
    window.history.replaceState({}, '', window.location.pathname);

    await loadFromSupabase();
    subscribeRealtime();
    showApp();
    showToast(`Selamat datang, ${partnerName}! 💑`);
  });

  return true;
}
/* ── SESSION RESTORE ── */
async function restoreSession() {
  const { data: { session } } = await sbClient.auth.getSession();
  if (!session) return false;
  currentUser = session.user;
  await afterLogin();
  return true;
}
async function afterLogin() {
  // Find couple where this user is email1 or email2
  const email = currentUser.email;
  const { data: couples, error } = await sbClient
    .from('couples')
    .select('*')
    .or(`email1.eq.${email},email2.eq.${email}`)
    .limit(1);

  if (error || !couples?.length) {
    showToast('Akun belum terhubung ke couple. Daftar dulu ya.', 'error');
    await sbClient.auth.signOut();
    return;
  }

  currentCouple = couples[0];
  await loadFromSupabase();
  subscribeRealtime();
  showApp();
  showToast(`Selamat datang kembali! 👋`);
}
function showApp() {
  $('auth-screen').classList.add('hidden');
  $('join-screen').classList.add('hidden');
  $('app').classList.remove('hidden');
  applyTheme(state.settings.theme);
  initApp();
}
function setAuthLoading(on) {
  $('login-btn').disabled = on;
  $('register-btn').disabled = on;
  $('login-btn').querySelector('span').textContent = on ? 'Memuat…' : 'Masuk ke CoupleGoal';
}
function setJoinLoading(on) {
  $('join-btn').disabled = on;
  $('join-btn').querySelector('span').textContent = on ? 'Memuat…' : 'Gabung & Mulai';
}

/* ══════════════════════════════════════════
   TOAST & CONFIRM
══════════════════════════════════════════ */
let toastContainer;
function showToast(msg, type = 'success', dur = 2800) {
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.className = 'toast-container';
    document.body.appendChild(toastContainer);
  }
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  t.innerHTML = `<span>${icons[type] || ''}</span><span>${msg}</span>`;
  toastContainer.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0'; t.style.transform = 'translateX(40px)'; t.style.transition = '0.3s';
    setTimeout(() => t.remove(), 300);
  }, dur);
}

let confirmResolve = null;
function showConfirm(title, message, type = 'danger') {
  return new Promise(resolve => {
    $('confirm-title').textContent = title;
    $('confirm-message').textContent = message;
    $('confirm-ok').className = `btn btn-primary flex-1`;
    $('confirm-modal').classList.remove('hidden');
    confirmResolve = resolve;
    setTimeout(() => $('confirm-ok').focus(), 100);
  });
}
$('confirm-cancel').addEventListener('click', () => { $('confirm-modal').classList.add('hidden'); if (confirmResolve) confirmResolve(false); });
$('confirm-ok').addEventListener('click',     () => { $('confirm-modal').classList.add('hidden'); if (confirmResolve) confirmResolve(true); });

/* ══════════════════════════════════════════
   ALL EVENT LISTENERS — dipanggil dari DOMContentLoaded
══════════════════════════════════════════ */
function initAllListeners() {

/* ── LOGIN ── */
$('login-btn').addEventListener('click', async () => {
  const email = $('login-email').value.trim();
  const password = $('login-password').value;
  if (!email || !password) { showToast('Isi email dan password', 'error'); return; }

  setAuthLoading(true);
  const { data, error } = await sbClient.auth.signInWithPassword({ email, password });
  setAuthLoading(false);

  if (error) { showToast('Login gagal: ' + error.message, 'error'); return; }
  currentUser = data.user;
  await afterLogin();
});

/* ── REGISTER ── */
$('register-btn').addEventListener('click', async () => {
  const name1     = $('reg-name1').value.trim();
  const email1    = $('reg-email1').value.trim().toLowerCase();
  const name2     = $('reg-name2').value.trim();
  const email2    = $('reg-email2').value.trim().toLowerCase();
  const password  = $('reg-password').value;
  const currency  = $('reg-currency').value;

  if (!name1 || !email1 || !name2 || !email2 || !password) {
    showToast('Semua field wajib diisi', 'error'); return;
  }
  if (password.length < 6) { showToast('Password minimal 6 karakter', 'error'); return; }
  if (email1 === email2) { showToast('Email kamu dan pasangan harus berbeda', 'error'); return; }

  setAuthLoading(true);

  // 1. Sign up user 1
  const { data: signupData, error: signupErr } = await sbClient.auth.signUp({ email: email1, password });
  if (signupErr) { setAuthLoading(false); showToast('Registrasi gagal: ' + signupErr.message, 'error'); return; }

  currentUser = signupData.user;

  // 2. Create couple record
  const { data: couple, error: coupleErr } = await sbClient.from('couples').insert({
    name1, name2, email1, email2, currency,
  }).select().single();

  if (coupleErr) { setAuthLoading(false); showToast('Gagal buat couple: ' + coupleErr.message, 'error'); return; }

  currentCouple = couple;
  setAuthLoading(false);

  // 3. Show invite link for partner
  const inviteLink = buildInviteLink(couple.id, name2, email2);
  $('invite-partner-name').textContent = name2;
  $('invite-link-text').textContent = inviteLink;

  switchAuthTab('invite');
});

/* ── INVITE LINK ── */

$('copy-invite-btn').addEventListener('click', () => {
  navigator.clipboard.writeText($('invite-link-text').textContent)
    .then(() => showToast('Link berhasil disalin! 📋'))
    .catch(() => showToast('Gagal salin, copy manual ya', 'error'));
});

$('skip-invite-btn').addEventListener('click', async () => {
  await loadFromSupabase();
  subscribeRealtime();
  showApp();
});













/* ── LOGOUT ── */
$('logout-btn').addEventListener('click', async () => {
  const ok = await showConfirm('Logout?', 'Kamu akan keluar dari CoupleGoal.');
  if (!ok) return;
  await sbClient.auth.signOut();
  location.reload();
});






} /* end initAllListeners */

/* ══════════════════════════════════════════
   NAVIGATION
══════════════════════════════════════════ */
let currentPage = 'dashboard';
let sidebarOverlay;

function navigateTo(page) {
  currentPage = page;
  $$('.page').forEach(p => p.classList.remove('active'));
  $(`page-${page}`)?.classList.add('active');
  $$('.nav-item').forEach(n => n.classList.remove('active'));
  $(`nav-${page}`)?.classList.add('active');

  // Show/hide + Anggaran button di topbar
  const budgetPages = ['income','fixed','variable','loan','savings','investments'];
  const addBudgetBtn = $('add-budget-btn');
  if (addBudgetBtn) addBudgetBtn.style.display = budgetPages.includes(page) ? '' : 'none';

  const titles = {
    home: '🏠 Panduan', dashboard: 'Dashboard', transactions: '📋 Transaksi',
    report: '📊 Laporan Bulanan', goals: '🎯 Savings Goals',
    split: '✂️ Split Calculator',
    income: '💼 Pemasukan', fixed: '🏠 Pengeluaran Tetap',
    variable: '🛍️ Pengeluaran Variabel', loan: '💳 Cicilan',
    savings: '🐷 Tabungan', investments: '📈 Investasi',
  };
  $('topbar-title').textContent = titles[page] || page;

  if (window.innerWidth <= 900) {
    $('sidebar').classList.remove('open');
    if (sidebarOverlay) sidebarOverlay.classList.remove('show');
  }
  renderPage(page);
}

function renderPage(page) {
  if (page === 'home')         renderHomePage();
  else if (page === 'dashboard')    renderDashboard();
  else if (CATEGORIES.find(c => c.key === page)) renderCategoryPage(page);
  else if (page === 'transactions') renderTransactionsPage();
  else if (page === 'report')  renderMonthlyReport();
  else if (page === 'goals')   renderGoalsPage();
  else if (page === 'split')   renderSplitPage();
}

/* ══════════════════════════════════════════
   FINANCIAL HEALTH SCORE
══════════════════════════════════════════ */
function calcHealthScore() {
  const incomeBudget  = calcBudget('income');
  const incomeActual  = calcActual('income');
  const expenseActual = calcTotalActual(EXPENSE_CATEGORIES);
  const savBudget     = calcBudget('savings') + calcBudget('investments');
  const savActual     = calcActual('savings') + calcActual('investments');
  const loanActual    = calcActual('loan');

  if (incomeBudget === 0 && incomeActual === 0) return { score: 0, grade: 'Belum Ada Data', tips: [], color: '#5a6690' };

  const income = incomeActual || incomeBudget;
  let score = 0;
  const tips = [];

  // 1. Savings rate (40 pts) — ideal >= 20%
  const savRate = income > 0 ? savActual / income : 0;
  const savScore = Math.min(savRate / 0.20, 1) * 40;
  score += savScore;
  if (savRate < 0.10) tips.push('💡 Coba tingkatkan tabungan ke minimal 10% dari pemasukan');
  else if (savRate < 0.20) tips.push('👍 Tabungan OK, targetkan 20% untuk lebih aman');
  else tips.push('🌟 Rasio tabungan sangat bagus!');

  // 2. Expense control (30 pts) — ideal expenses < 70% of income
  const expRatio = income > 0 ? expenseActual / income : 1;
  const expScore = Math.max(0, 1 - (expRatio - 0.5) / 0.5) * 30;
  score += expScore;
  if (expRatio > 0.90) tips.push('⚠️ Pengeluaran melebihi 90% pemasukan — kurangi kategori variabel');
  else if (expRatio > 0.70) tips.push('📊 Pengeluaran 70-90% pemasukan — masih bisa dioptimalkan');
  else tips.push('✅ Pengeluaran terkendali dengan baik');

  // 3. Loan burden (20 pts) — ideal < 30% of income
  const loanRatio = income > 0 ? loanActual / income : 0;
  const loanScore = Math.max(0, 1 - loanRatio / 0.30) * 20;
  score += loanScore;
  if (loanRatio > 0.40) tips.push('🔴 Cicilan terlalu besar, pertimbangkan refinancing');
  else if (loanRatio > 0.30) tips.push('🟡 Cicilan di batas aman, hati-hati tambah utang baru');

  // 4. Investment (10 pts)
  const invActual = calcActual('investments');
  const invScore  = income > 0 ? Math.min(invActual / income / 0.05, 1) * 10 : 0;
  score += invScore;
  if (invActual === 0) tips.push('📈 Mulai investasi, walau kecil. Compound interest bekerja!');

  const finalScore = Math.round(Math.max(0, Math.min(100, score)));

  let grade, color;
  if (finalScore >= 80)      { grade = '🏆 Excellent — Keuangan sangat sehat!'; color = '#34d399'; }
  else if (finalScore >= 65) { grade = '😊 Good — Keuangan cukup sehat'; color = '#38bdf8'; }
  else if (finalScore >= 50) { grade = '😐 Fair — Perlu beberapa perbaikan'; color = '#fbbf24'; }
  else if (finalScore >= 30) { grade = '😟 Poor — Perhatikan pengeluaran'; color = '#fb923c'; }
  else                        { grade = '🚨 Critical — Segera evaluasi keuangan'; color = '#f87171'; }

  return { score: finalScore, grade, tips: tips.slice(0, 3), color };
}

function renderHealthScore() {
  const { score, grade, tips, color } = calcHealthScore();
  const circumference = 2 * Math.PI * 40;
  const offset = circumference - (score / 100) * circumference;

  $('health-score-val').textContent = score;
  $('health-score-grade').textContent = grade;

  const ring = $('health-ring-fill');
  ring.style.stroke = color;
  setTimeout(() => { ring.style.strokeDashoffset = offset; }, 100);

  $('health-score-tips').innerHTML = tips.length
    ? tips.map(t => `<div class="health-tip">${t}</div>`).join('')
    : '<div class="health-tip">💡 Tambahkan data keuangan untuk tips personal</div>';
}


/* ══════════════════════════════════════════
   HOME PAGE
══════════════════════════════════════════ */
function renderHomePage() {
  const s = state.settings;
  const namesEl = document.getElementById('home-couple-names');
  if (namesEl && s.name1 && s.name2) {
    namesEl.textContent = s.name1 + ' & ' + s.name2;
  }
  // Update nama pasangan di assignee cards
  const p1Title = document.getElementById('home-assignee-title-p1');
  const p2Title = document.getElementById('home-assignee-title-p2');
  const p1Icon  = document.getElementById('home-assignee-icon-p1');
  const p2Icon  = document.getElementById('home-assignee-icon-p2');
  if (p1Title) p1Title.textContent = s.name1 || 'Pasangan 1';
  if (p2Title) p2Title.textContent = s.name2 || 'Pasangan 2';
  if (p1Icon)  p1Icon.textContent  = (s.name1?.[0] || '👤').toUpperCase();
  if (p2Icon)  p2Icon.textContent  = (s.name2?.[0] || '👤').toUpperCase();
}

/* ══════════════════════════════════════════
   DASHBOARD
══════════════════════════════════════════ */
let donutChart = null, barChart = null;

function renderDashboard() {
  const s = state.settings;
  // Sync month picker
  const picker = $('dash-month-picker');
  if (picker && picker.value !== s.month) picker.value = s.month || '';
  $('dash-title').textContent = `Budget ${s.name1} & ${s.name2}`;
  $('dash-month-label').textContent = monthLabel(s.month);

  const incomeBudget  = calcBudget('income');
  const incomeActual  = calcActual('income');
  const expenseBudget = calcTotalBudget(EXPENSE_CATEGORIES);
  const expenseActual = calcTotalActual(EXPENSE_CATEGORIES);
  const savBudget     = calcBudget('savings') + calcBudget('investments');
  const savActual     = calcActual('savings') + calcActual('investments');
  const leftBudget    = incomeBudget - expenseBudget - savBudget;
  const leftActual    = incomeActual - expenseActual - savActual;

  $('dash-income-budget').textContent  = fmt(incomeBudget);
  $('dash-income-actual').textContent  = `Aktual: ${fmt(incomeActual)}`;
  $('dash-expense-budget').textContent = fmt(expenseBudget);
  $('dash-expense-actual').textContent = `Aktual: ${fmt(expenseActual)}`;
  $('dash-save-budget').textContent    = fmt(savBudget);
  $('dash-save-actual').textContent    = `Aktual: ${fmt(savActual)}`;
  $('dash-left-budget').textContent    = fmt(leftBudget);
  $('dash-left-actual').textContent    = `Sisa Aktual: ${fmt(leftActual)}`;

  const ip = $('dash-income-pill');
  ip.textContent = incomeActual >= incomeBudget && incomeBudget > 0 ? 'ON TARGET ✅' : incomeActual === 0 ? 'BELUM ADA' : 'PROGRES';

  const ep = $('dash-expense-pill');
  if (expenseActual > expenseBudget && expenseBudget > 0) { ep.textContent = 'OVER BUDGET ⚠️'; ep.className = 'summary-pill over'; }
  else { ep.textContent = 'ON BUDGET ✅'; ep.className = 'summary-pill'; }

  renderHealthScore();
  renderDonutChart();
  renderBarChart();
  renderProgressCircle();
  renderPersonBreakdown();
  renderCategoryStatusBars();
  renderRecentTransactions();
  renderFinanceSticker();
}

function getAxisColor() { return getComputedStyle(document.body).getPropertyValue('--chart-axis').trim() || '#94a3b8'; }
function getGridColor()  { return getComputedStyle(document.body).getPropertyValue('--chart-grid').trim() || 'rgba(255,255,255,0.05)'; }

function renderDonutChart() {
  const ctx = $('donut-budget'); if (!ctx) return;
  const labels = CATEGORIES.map(c => c.label);
  const data   = CATEGORIES.map(c => calcBudget(c.key));
  const colors = CATEGORIES.map(c => c.color);
  const total  = data.reduce((s, v) => s + v, 0);
  $('donut-budget-total').textContent = fmt(total);
  $('donut-legend').innerHTML = CATEGORIES.map((c, i) => `
    <div class="legend-item">
      <span class="legend-dot" style="background:${colors[i]}"></span>
      <span>${c.icon} ${c.label}</span>
      <span class="legend-val">${fmt(data[i])}</span>
    </div>`).join('');
  if (donutChart) donutChart.destroy();
  if (total === 0) return;
  donutChart = new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 2, borderColor: 'transparent', hoverOffset: 6 }] },
    options: { cutout: '68%', responsive: true, maintainAspectRatio: true, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ${fmt(ctx.parsed)}` } } }, animation: { animateRotate: true, duration: 800 } }
  });
}

function renderBarChart() {
  const ctx = $('bar-overview'); if (!ctx) return;
  const labels  = CATEGORIES.map(c => c.icon + ' ' + c.label.split(' ')[0]);
  const budget  = CATEGORIES.map(c => calcBudget(c.key));
  const actual  = CATEGORIES.map(c => calcActual(c.key));
  const colors  = CATEGORIES.map(c => c.color);
  if (barChart) barChart.destroy();
  if (budget.reduce((a,b)=>a+b,0) === 0 && actual.reduce((a,b)=>a+b,0) === 0) return;
  barChart = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [
      { label: 'Budget', data: budget, backgroundColor: colors.map(c => c+'55'), borderColor: colors, borderWidth: 2, borderRadius: 6 },
      { label: 'Aktual', data: actual, backgroundColor: colors.map(c => c+'aa'), borderColor: colors, borderWidth: 2, borderRadius: 6 },
    ]},
    options: {
      responsive: true, maintainAspectRatio: true,
      plugins: { legend: { labels: { color: getAxisColor(), font: { size: 11 } } }, tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${fmt(ctx.parsed.y)}` } } },
      scales: {
        x: { ticks: { color: getAxisColor(), font: { size: 10 } }, grid: { color: getGridColor() } },
        y: { ticks: { color: getAxisColor(), font: { size: 10 }, callback: v => fmt(v) }, grid: { color: getGridColor() } },
      },
    }
  });
}

function renderProgressCircle() {
  const ms = getMonthStats();
  const circumference = 2 * Math.PI * 40;
  const offset = circumference - (ms.pct / 100) * circumference;
  const circle = $('prog-fill-circle');
  setTimeout(() => { if (circle) circle.style.strokeDashoffset = offset; }, 100);
  $('month-prog-pct').textContent = ms.pct + '%';
  $('stat-days-passed').textContent = ms.passed;
  $('stat-days-left').textContent   = ms.left;
  $('stat-days-total').textContent  = ms.total;

  // SVG gradient
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.querySelector('.month-progress-circle svg');
  if (svg && !svg.querySelector('#prog-gradient')) {
    const defs = document.createElementNS(svgNS, 'defs');
    const grad = document.createElementNS(svgNS, 'linearGradient');
    grad.setAttribute('id', 'prog-gradient');
    grad.setAttribute('x1', '0%'); grad.setAttribute('y1', '0%');
    grad.setAttribute('x2', '100%'); grad.setAttribute('y2', '0%');
    const s1 = document.createElementNS(svgNS, 'stop');
    s1.setAttribute('offset', '0%'); s1.setAttribute('stop-color', '#7c6fff');
    const s2 = document.createElementNS(svgNS, 'stop');
    s2.setAttribute('offset', '100%'); s2.setAttribute('stop-color', '#ff6b8a');
    grad.appendChild(s1); grad.appendChild(s2); defs.appendChild(grad);
    svg.insertBefore(defs, svg.firstChild);
  }
}

function renderPersonBreakdown() {
  const s = state.settings;
  const persons = [
    { key: 'p1', name: s.name1, label: s.name1, cls: '' },
    { key: 'p2', name: s.name2, label: s.name2, cls: 'p2' },
    { key: 'shared', name: 'Shared', label: '🤝 Bersama', cls: 'shared' },
  ];
  $('person-grid').innerHTML = persons.map(p => {
    const incomeBudget  = calcBudget('income', p.key);
    const incomeActual  = calcActual('income', p.key);
    const expenseBudget = EXPENSE_CATEGORIES.reduce((s, c) => s + calcBudget(c, p.key), 0);
    const expenseActual = EXPENSE_CATEGORIES.reduce((s, c) => s + calcActual(c, p.key), 0);
    return `<div class="person-card ${p.cls}">
      <div class="person-card-header">
        <div class="person-card-avatar">${(p.name[0] || '?').toUpperCase()}</div>
        <div class="person-card-name">${p.label}</div>
      </div>
      <div class="person-stat-row"><span class="person-stat-label">Budget Masuk</span><span class="person-stat-val">${fmt(incomeBudget)}</span></div>
      <div class="person-stat-row"><span class="person-stat-label">Aktual Masuk</span><span class="person-stat-val" style="color:var(--income-color)">${fmt(incomeActual)}</span></div>
      <div class="person-stat-row"><span class="person-stat-label">Budget Keluar</span><span class="person-stat-val">${fmt(expenseBudget)}</span></div>
      <div class="person-stat-row"><span class="person-stat-label">Aktual Keluar</span><span class="person-stat-val" style="color:${expenseActual > expenseBudget && expenseBudget > 0 ? '#ef4444' : 'var(--expense-color)'}">${fmt(expenseActual)}</span></div>
    </div>`;
  }).join('');
}

function renderCategoryStatusBars() {
  $('category-status-bars').innerHTML = CATEGORIES.map(c => {
    const budget = calcBudget(c.key);
    const actual = calcActual(c.key);
    const pct    = budget > 0 ? Math.min((actual / budget) * 100, 120) : 0;
    const over   = actual > budget && budget > 0;
    return `<div class="cat-bar-item">
      <div class="cat-bar-header">
        <span class="cat-bar-label">${c.icon} ${c.label}</span>
        <span class="cat-bar-vals">${fmt(actual)} / ${fmt(budget)} <span style="color:${over ? '#ef4444' : 'var(--text-muted)'};">${over ? '▲ OVER' : ''}</span></span>
      </div>
      <div class="progress-track"><div class="progress-fill ${over ? 'over' : ''}" style="width:${Math.min(pct,100)}%;background:${c.color};"></div></div>
    </div>`;
  }).join('');
}

function renderRecentTransactions() {
  const month = state.settings.month;
  const txs = [...state.transactions]
    .filter(t => !month || !t.date || t.date.substring(0, 7) === month)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 8);
  if (!txs.length) {
    $('recent-tx-list').innerHTML = `<div class="empty-state"><div class="empty-icon">📭</div><p>Belum ada transaksi bulan ini</p></div>`;
    return;
  }
  $('recent-tx-list').innerHTML = txs.map(t => renderTxItem(t, true)).join('');
}

function renderTxItem(t) {
  const cat  = CATEGORIES.find(c => c.key === t.type) || { icon: '💰', color: '#8b5cf6' };
  const s    = state.settings;
  const name = t.assignee === 'p1' ? s.name1 : t.assignee === 'p2' ? s.name2 : 'Shared';
  const isIncome = t.type === 'income';
  return `<div class="tx-item" data-id="${t.id}">
    <div class="tx-icon" style="background:${cat.color}22;color:${cat.color};">${cat.icon}</div>
    <div class="tx-body">
      <div class="tx-desc">${t.description || '—'}</div>
      <div class="tx-meta">${fmtDate(t.date)} · ${cat.label} · ${name}</div>
    </div>
    <div class="tx-amount ${isIncome ? 'income' : 'expense'}">${isIncome ? '+' : '-'}${fmt(t.amount)}</div>
    <div class="tx-actions"><button class="tx-delete-btn" onclick="deleteTx('${t.id}')">🗑️ Hapus</button></div>
  </div>`;
}

/* ══════════════════════════════════════════
   TRANSACTIONS PAGE
══════════════════════════════════════════ */
function renderTransactionsPage() {
  const typeFilter    = $('filter-type').value;
  const assigneeFilter = $('filter-assignee').value;
  const searchVal     = $('filter-search').value.toLowerCase();
  const sort          = $('sort-tx').value;
  const month         = state.settings.month;

  let txs = state.transactions.filter(t => {
    if (month && t.date && t.date.substring(0, 7) !== month) return false;
    if (typeFilter && t.type !== typeFilter) return false;
    if (assigneeFilter && t.assignee !== assigneeFilter) return false;
    if (searchVal && !t.description?.toLowerCase().includes(searchVal)) return false;
    return true;
  });

  txs.sort((a, b) => {
    if (sort === 'date-desc')   return new Date(b.date) - new Date(a.date);
    if (sort === 'date-asc')    return new Date(a.date) - new Date(b.date);
    if (sort === 'amount-desc') return b.amount - a.amount;
    if (sort === 'amount-asc')  return a.amount - b.amount;
    return 0;
  });

  $('tx-count-label').textContent = `${txs.length} transaksi`;

  const totalIn  = txs.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const totalOut = txs.filter(t => t.type !== 'income').reduce((s, t) => s + t.amount, 0);
  $('tx-stats-row').innerHTML = `
    <div class="tx-stat-card"><div class="tx-stat-val" style="color:var(--income-color)">+${fmt(totalIn)}</div><div class="tx-stat-label">Total Pemasukan</div></div>
    <div class="tx-stat-card"><div class="tx-stat-val" style="color:var(--expense-color)">${fmt(totalOut)}</div><div class="tx-stat-label">Total Pengeluaran</div></div>
    <div class="tx-stat-card"><div class="tx-stat-val" style="color:${totalIn-totalOut>=0?'#10b981':'#ef4444'}">${fmt(totalIn-totalOut)}</div><div class="tx-stat-label">Net Balance</div></div>
    <div class="tx-stat-card"><div class="tx-stat-val">${txs.length}</div><div class="tx-stat-label">Jumlah Transaksi</div></div>`;

  if (!txs.length) {
    $('tx-list-wrap').innerHTML = `<div class="empty-state"><div class="empty-icon">📭</div><p>Tidak ada transaksi yang cocok</p></div>`;
    return;
  }
  $('tx-list-wrap').innerHTML = `<div class="tx-list-card">${txs.map(t => renderTxItem(t)).join('')}</div>`;
}

/* ══════════════════════════════════════════
   MONTHLY REPORT
══════════════════════════════════════════ */
let trendChart = null;

function renderMonthlyReport() {
  const currentMonth = state.settings.month;
  if (!currentMonth) {
    $('narrative-text').textContent = 'Set bulan anggaran di Pengaturan untuk melihat laporan.';
    return;
  }

  // Generate last 6 months
  const [cy, cm] = currentMonth.split('-').map(Number);
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(cy, cm - 1 - i, 1);
    months.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
  }

  // Calc per month
  const incomeData  = months.map(m => calcActualForMonth('income', m));
  const expenseData = months.map(m => EXPENSE_CATEGORIES.reduce((s, c) => s + calcActualForMonth(c, m), 0));
  const savData     = months.map(m => calcActualForMonth('savings', m) + calcActualForMonth('investments', m));
  const labels      = months.map(m => { const [y, mo] = m.split('-'); return new Date(+y, +mo-1,1).toLocaleDateString('id-ID', {month:'short'}); });

  // Trend chart
  const ctx = $('trend-chart'); if (!ctx) return;
  if (trendChart) trendChart.destroy();
  trendChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Pemasukan', data: incomeData,  borderColor: '#34d399', backgroundColor: 'rgba(52,211,153,0.1)', tension: 0.4, fill: true, pointRadius: 4 },
        { label: 'Pengeluaran', data: expenseData, borderColor: '#f87171', backgroundColor: 'rgba(248,113,113,0.1)', tension: 0.4, fill: true, pointRadius: 4 },
        { label: 'Tabungan+Inv', data: savData,  borderColor: '#38bdf8', backgroundColor: 'rgba(56,189,248,0.08)', tension: 0.4, fill: true, pointRadius: 4 },
      ]
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: getAxisColor() } }, tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${fmt(ctx.parsed.y)}` } } },
      scales: {
        x: { ticks: { color: getAxisColor() }, grid: { color: getGridColor() } },
        y: { ticks: { color: getAxisColor(), callback: v => fmt(v) }, grid: { color: getGridColor() } },
      }
    }
  });

  // Narrative
  const currIncome  = incomeData[5];
  const currExpense = expenseData[5];
  const prevIncome  = incomeData[4];
  const prevExpense = expenseData[4];
  const net = currIncome - currExpense;
  const savRate = currIncome > 0 ? ((savData[5] / currIncome) * 100).toFixed(0) : 0;

  let narrative = `Bulan ${monthLabel(currentMonth)}, `;
  if (currIncome > 0) {
    narrative += `kalian mencatat pemasukan ${fmt(currIncome)}`;
    if (prevIncome > 0) {
      const diff = ((currIncome - prevIncome) / prevIncome * 100).toFixed(0);
      narrative += ` (${diff > 0 ? '+' : ''}${diff}% vs bulan lalu)`;
    }
    narrative += `. Pengeluaran ${fmt(currExpense)}, menyisakan ${fmt(net)}.`;
    if (savRate > 0) narrative += ` Rasio tabungan kalian bulan ini ${savRate}%.`;
    if (net < 0) narrative += ' ⚠️ Pengeluaran melebihi pemasukan — perlu dievaluasi.';
    else if (parseFloat(savRate) >= 20) narrative += ' 🎉 Rasio tabungan sangat baik!';
  } else {
    narrative = 'Belum ada data pemasukan untuk bulan ini. Tambahkan transaksi untuk melihat ringkasan.';
  }
  $('narrative-text').textContent = narrative;

  // Compare grid
  const prevMonth = months[4];
  $('report-compare-grid').innerHTML = [
    { label: 'Pemasukan', curr: currIncome, prev: prevIncome, positive: true },
    { label: 'Pengeluaran', curr: currExpense, prev: prevExpense, positive: false },
    { label: 'Tabungan+Inv', curr: savData[5], prev: savData[4], positive: true },
  ].map(item => {
    const diff = item.prev > 0 ? ((item.curr - item.prev) / item.prev * 100).toFixed(0) : null;
    const diffUp = diff !== null && ((item.positive && parseFloat(diff) > 0) || (!item.positive && parseFloat(diff) < 0));
    return `<div class="compare-item">
      <div class="compare-label">${item.label}</div>
      <div class="compare-curr">${fmt(item.curr)}</div>
      <div class="compare-prev">Lalu: ${fmt(item.prev)}</div>
      ${diff !== null ? `<div class="compare-diff ${diffUp ? 'up' : 'down'}">${parseFloat(diff) > 0 ? '▲' : '▼'} ${Math.abs(diff)}%</div>` : ''}
    </div>`;
  }).join('');
}

function calcActualForMonth(cat, month) {
  return state.transactions.filter(t => t.type === cat && t.date && t.date.substring(0, 7) === month)
    .reduce((s, t) => s + (t.amount || 0), 0);
}

/* ══════════════════════════════════════════
   SAVINGS GOALS
══════════════════════════════════════════ */
function renderGoalsPage() {
  const goals = state.goals || [];
  if (!goals.length) {
    $('goals-grid').innerHTML = `<div class="goal-empty"><div class="goal-empty-icon">🎯</div><p>Belum ada savings goal.<br>Tambah goal pertama kalian!</p></div>`;
    return;
  }
  $('goals-grid').innerHTML = goals.map(g => {
    const pct = g.target > 0 ? Math.min((g.saved / g.target) * 100, 100) : 0;
    const remaining = Math.max(0, g.target - g.saved);
    const deadline  = g.deadline ? fmtDate(g.deadline) : '—';
    // Estimate months needed
    const monthlyAvg = calcBudget('savings') + calcBudget('investments');
    const estMonths  = monthlyAvg > 0 && remaining > 0 ? Math.ceil(remaining / monthlyAvg) : null;
    return `<div class="goal-card">
      <div class="goal-header">
        <div class="goal-icon-wrap">${g.icon || '🎯'}</div>
        <div class="goal-actions">
          <button class="goal-action-btn" onclick="openEditGoal('${g.id}')" title="Edit">✏️</button>
          <button class="goal-action-btn" onclick="deleteGoal('${g.id}')" title="Hapus">🗑️</button>
        </div>
      </div>
      <div class="goal-name">${g.name}</div>
      <div class="goal-deadline">🗓️ Target: ${deadline}</div>
      <div class="goal-amounts">
        <div class="goal-saved">${fmt(g.saved)}</div>
        <div class="goal-target">dari ${fmt(g.target)}</div>
      </div>
      <div class="goal-progress-track">
        <div class="goal-progress-fill" style="width:${pct}%"></div>
      </div>
      <div class="goal-footer">
        <span class="goal-pct">${pct.toFixed(0)}% tercapai</span>
        <span>${estMonths ? `~${estMonths} bln lagi` : remaining > 0 ? fmt(remaining) + ' lagi' : '🎉 Tercapai!'}</span>
      </div>
    </div>`;
  }).join('');
}

$('add-goal-btn').addEventListener('click', () => openAddGoal());

function openAddGoal() {
  $('goal-modal-title').textContent = 'Tambah Goal';
  $('goal-edit-id').value   = '';
  $('goal-name').value      = '';
  $('goal-target').value    = '';
  $('goal-saved').value     = '';
  $('goal-deadline').value  = '';
  $('goal-icon').value      = '';
  $('goal-currency').textContent  = state.settings.currency;
  $('goal-currency2').textContent = state.settings.currency;
  $('goal-modal').classList.remove('hidden');
  setTimeout(() => $('goal-name').focus(), 100);
}

function openEditGoal(id) {
  const g = (state.goals || []).find(g => g.id === id);
  if (!g) return;
  $('goal-modal-title').textContent = 'Edit Goal';
  $('goal-edit-id').value   = g.id;
  $('goal-name').value      = g.name;
  $('goal-target').value    = g.target ? parseInt(g.target).toLocaleString('id-ID') : '';
  $('goal-target').dataset.rawValue = String(g.target || 0);
  $('goal-saved').value     = g.saved ? parseInt(g.saved).toLocaleString('id-ID') : '';
  $('goal-saved').dataset.rawValue = String(g.saved || 0);
  $('goal-deadline').value  = g.deadline || '';
  $('goal-icon').value      = g.icon || '';
  $('goal-currency').textContent  = state.settings.currency;
  $('goal-currency2').textContent = state.settings.currency;
  $('goal-modal').classList.remove('hidden');
}
window.openEditGoal = openEditGoal;

$('goal-save').addEventListener('click', () => {
  const name     = $('goal-name').value.trim();
  const target   = getRawValue($('goal-target'));
  const saved    = getRawValue($('goal-saved'));
  const deadline = $('goal-deadline').value;
  const icon     = $('goal-icon').value.trim() || '🎯';
  const editId   = $('goal-edit-id').value;
  if (!name || target <= 0) { showToast('Nama dan target wajib diisi', 'error'); return; }

  if (!state.goals) state.goals = [];
  if (editId) {
    const idx = state.goals.findIndex(g => g.id === editId);
    if (idx >= 0) state.goals[idx] = { ...state.goals[idx], name, target, saved, deadline, icon };
    showToast('Goal diperbarui ✅');
  } else {
    state.goals.push({ id: generateId(), name, target, saved, deadline, icon });
    showToast('Goal ditambahkan ✅');
  }
  saveState();
  $('goal-modal').classList.add('hidden');
  renderGoalsPage();
});

async function deleteGoal(id) {
  const ok = await showConfirm('Hapus Goal?', 'Goal ini akan dihapus permanen.');
  if (!ok) return;
  state.goals = (state.goals || []).filter(g => g.id !== id);
  saveState();
  renderGoalsPage();
  showToast('Goal dihapus', 'info');
}
window.deleteGoal = deleteGoal;

$('goal-modal-close').addEventListener('click', () => $('goal-modal').classList.add('hidden'));
$('goal-cancel').addEventListener('click',       () => $('goal-modal').classList.add('hidden'));

/* ══════════════════════════════════════════
   SPLIT CALCULATOR
══════════════════════════════════════════ */
function renderSplitPage() {
  const s = state.settings;
  $('split-currency').textContent  = s.currency;
  $('split-label-p1').textContent  = s.name1 || 'Pasangan 1';
  $('split-label-p2').textContent  = s.name2 || 'Pasangan 2';
  renderSplitHistory();
}

$('split-ratio').addEventListener('input', () => {
  const v = $('split-ratio').value;
  $('split-ratio-display').textContent = `${v} : ${100 - v}`;
  $$('.preset-btn').forEach(b => b.classList.toggle('active', b.dataset.val === v));
});

$$('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $('split-ratio').value = btn.dataset.val;
    $('split-ratio').dispatchEvent(new Event('input'));
  });
});

$('calc-split-btn').addEventListener('click', () => {
  const desc   = $('split-desc').value.trim();
  const total  = getRawValue($('split-amount'));
  const ratio  = parseInt($('split-ratio').value);
  const s      = state.settings;
  if (total <= 0) { showToast('Masukkan jumlah yang valid', 'error'); return; }

  const amt1 = total * (ratio / 100);
  const amt2 = total * ((100 - ratio) / 100);
  const name1 = s.name1 || 'Pasangan 1';
  const name2 = s.name2 || 'Pasangan 2';

  $('split-result').innerHTML = `
    <div class="split-result-inner">
      <div class="split-result-title">${desc || 'Pembagian Biaya'}</div>
      <div class="split-person-card">
        <div class="split-person-info">
          <div class="split-person-avatar">${name1[0]?.toUpperCase() || 'A'}</div>
          <div><div class="split-person-name">${name1}</div><div class="split-pct-badge">${ratio}%</div></div>
        </div>
        <div class="split-amount">${fmt(amt1)}</div>
      </div>
      <div class="split-person-card">
        <div class="split-person-info">
          <div class="split-person-avatar split-p2-avatar">${name2[0]?.toUpperCase() || 'B'}</div>
          <div><div class="split-person-name">${name2}</div><div class="split-pct-badge">${100 - ratio}%</div></div>
        </div>
        <div class="split-amount">${fmt(amt2)}</div>
      </div>
      <div class="split-total-line">
        <span class="split-total-label">Total Pengeluaran</span>
        <span class="split-total-val">${fmt(total)}</span>
      </div>
    </div>`;

  // Save to history
  if (!state.splitHistory) state.splitHistory = [];
  state.splitHistory.unshift({
    id: generateId(),
    desc: desc || 'Pengeluaran',
    total, ratio,
    amt1, amt2,
    name1, name2,
    date: new Date().toISOString().split('T')[0],
  });
  if (state.splitHistory.length > 20) state.splitHistory = state.splitHistory.slice(0, 20);
  saveState();
  renderSplitHistory();
  showToast('Kalkulasi disimpan ✅');
});

function renderSplitHistory() {
  const list = $('split-history-list');
  const history = state.splitHistory || [];
  if (!history.length) {
    list.innerHTML = `<div class="split-history-empty">Belum ada riwayat split</div>`;
    return;
  }
  list.innerHTML = history.slice(0, 10).map(h => `
    <div class="split-history-item">
      <div>
        <div class="split-history-desc">${h.desc}</div>
        <div class="split-history-meta">${fmtDate(h.date)} · ${h.ratio}/${100-h.ratio}</div>
      </div>
      <div class="split-history-total">${fmt(h.total)}</div>
    </div>`).join('');
}

/* ══════════════════════════════════════════
   BUDGET CATEGORY PAGES
══════════════════════════════════════════ */
function renderCategoryPage(cat) {
  const meta  = CATEGORIES.find(c => c.key === cat);
  if (!meta) return;
  const items = state.budgetItems[cat] || [];
  const s     = state.settings;
  const totalBudget = calcBudget(cat);
  const totalActual = calcActual(cat);
  const diff        = totalActual - totalBudget;

  $(`${cat}-summary-bar`).innerHTML = `
    <div class="cat-stat-card"><div class="cat-stat-label">Total Anggaran</div><div class="cat-stat-val">${fmt(totalBudget)}</div></div>
    <div class="cat-stat-card"><div class="cat-stat-label">Total Aktual</div><div class="cat-stat-val" style="color:${meta.color}">${fmt(totalActual)}</div></div>
    <div class="cat-stat-card"><div class="cat-stat-label">Selisih</div><div class="cat-stat-val" style="color:${diff>0?'#ef4444':'#10b981'}">${diff>=0?'▲':'▼'} ${fmt(Math.abs(diff))}</div></div>
    <div class="cat-stat-card"><div class="cat-stat-label">Jumlah Item</div><div class="cat-stat-val">${items.length}</div></div>`;

  const tableWrap = $(`${cat}-table`);
  if (!items.length) {
    tableWrap.innerHTML = `<div class="empty-state" style="padding:3rem">
      <div class="empty-icon">${meta.icon}</div>
      <p>Belum ada item ${meta.label}. Tambah item pertama!</p>
      <button class="btn btn-primary btn-sm" style="margin-top:1rem" onclick="openAddBudgetItem('${cat}')">+ Tambah Item</button>
    </div>`;
    return;
  }

  const rows = items.map((item, i) => {
    const actual = getActualForItem(cat, item);
    const pct  = item.budget > 0 ? (actual / item.budget) * 100 : 0;
    const over = actual > item.budget && item.budget > 0;
    const name = item.assignee === 'p1' ? s.name1 : item.assignee === 'p2' ? s.name2 : 'Bersama';
    const badgeCls = item.assignee === 'shared' ? 'shared' : item.assignee === 'p2' ? 'p2' : '';
    return `<tr>
      <td><strong>${item.description}</strong></td>
      <td><span class="assignee-badge ${badgeCls}">${name}</span></td>
      <td>${fmt(item.budget)}</td>
      <td><span style="color:${over?'#ef4444':'var(--income-color)'}">${fmt(actual)}</span>
        <div class="progress-mini"><div class="progress-mini-fill ${over?'over':''}" style="width:${Math.min(pct,100)}%;background:${meta.color};"></div></div>
      </td>
      <td style="color:${over?'#ef4444':'#10b981'}">${over?'▲':'▼'} ${fmt(Math.abs(actual-item.budget))}</td>
      <td><div class="row-actions">
        <button class="row-edit-btn" onclick="openEditBudgetItem('${cat}',${i})">✏️ Edit</button>
        <button class="row-del-btn"  onclick="deleteBudgetItem('${cat}',${i})">🗑️</button>
      </div></td>
    </tr>`;
  }).join('');

  tableWrap.innerHTML = `<table class="budget-table">
    <thead><tr><th>Deskripsi</th><th>Pemilik</th><th>Anggaran</th><th>Aktual</th><th>Selisih</th><th>Aksi</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td colspan="2"><strong>TOTAL</strong></td><td><strong>${fmt(totalBudget)}</strong></td>
      <td><strong style="color:${meta.color}">${fmt(totalActual)}</strong></td>
      <td><strong style="color:${diff>0?'#ef4444':'#10b981'}">${diff>0?'▲':'▼'} ${fmt(Math.abs(diff))}</strong></td>
      <td></td></tr></tfoot>
  </table>`;
}

/* ══════════════════════════════════════════
   BUDGET ITEM MODAL
══════════════════════════════════════════ */
function openAddBudgetItem(cat) {
  $('bm-title').textContent   = 'Tambah Anggaran';
  $('bm-category').value      = cat;
  $('bm-edit-index').value    = -1;
  $('bm-item-id').value       = '';
  $('bm-desc').value          = '';
  $('bm-amount').value        = '';
  $('bm-assignee').value      = 'shared';
  $('bm-currency-prefix').textContent = state.settings.currency;

  // Placeholder kontekstual per kategori
  const placeholders = {
    income:      'contoh: Gaji, Freelance, Bisnis, Dividen…',
    fixed:       'contoh: Sewa Rumah, Internet, Asuransi, Streaming…',
    variable:    'contoh: Makan, Bensin, Belanja, Hiburan…',
    loan:        'contoh: KPR, Cicilan Motor, Paylater, KTA…',
    savings:     'contoh: Dana Darurat, Tabungan Nikah, Deposito…',
    investments: 'contoh: Reksa Dana, Saham, Emas, Crypto…',
  };
  $('bm-desc').placeholder = placeholders[cat] || 'contoh: Gaji, Sewa Rumah…';

  updateBudgetModalAssigneeNames();
  $('budget-modal').classList.remove('hidden');
  setTimeout(() => $('bm-desc').focus(), 100);
}
window.openAddBudgetItem = openAddBudgetItem;

function openEditBudgetItem(cat, idx) {
  const item = state.budgetItems[cat][idx];
  if (!item) return;
  $('bm-title').textContent   = 'Edit Anggaran';
  const placeholders = {
    income:'contoh: Gaji, Freelance, Bisnis…', fixed:'contoh: Sewa Rumah, Internet…',
    variable:'contoh: Makan, Bensin, Belanja…', loan:'contoh: KPR, Cicilan Motor…',
    savings:'contoh: Dana Darurat, Tabungan Nikah…', investments:'contoh: Reksa Dana, Saham…',
  };
  $('bm-desc').placeholder = placeholders[cat] || 'contoh: Gaji, Sewa Rumah…';
  $('bm-category').value      = cat;
  $('bm-edit-index').value    = idx;
  $('bm-item-id').value       = item.id || '';
  $('bm-desc').value          = item.description;
  $('bm-amount').value        = item.budget ? parseInt(item.budget).toLocaleString('id-ID') : '';
  $('bm-amount').dataset.rawValue = String(item.budget || 0);
  $('bm-assignee').value      = item.assignee;
  $('bm-currency-prefix').textContent = state.settings.currency;
  updateBudgetModalAssigneeNames();
  $('budget-modal').classList.remove('hidden');
  setTimeout(() => $('bm-desc').focus(), 100);
}
window.openEditBudgetItem = openEditBudgetItem;

function closeBudgetModal() { $('budget-modal').classList.add('hidden'); }

function saveBudgetItem() {
  const cat  = $('bm-category').value;
  const idx  = parseInt($('bm-edit-index').value);
  const id   = $('bm-item-id').value || generateId();
  const desc = $('bm-desc').value.trim();
  const amt  = getRawValue($('bm-amount'));
  const asn  = $('bm-assignee').value;
  if (!desc) { showToast('Deskripsi tidak boleh kosong', 'error'); return; }
  const item = { id, description: desc, assignee: asn, budget: amt };
  if (idx >= 0) { state.budgetItems[cat][idx] = item; showToast('Item diperbarui ✅'); }
  else { state.budgetItems[cat].push(item); showToast('Item ditambahkan ✅'); }
  saveState();
  closeBudgetModal();
  renderPage(currentPage);
}

async function deleteBudgetItem(cat, idx) {
  const item = state.budgetItems[cat][idx];
  const ok = await showConfirm('Hapus Item?', `Item "${item.description}" akan dihapus.`);
  if (!ok) return;
  state.budgetItems[cat].splice(idx, 1);
  saveState();
  renderPage(currentPage);
  showToast('Item dihapus', 'info');
}
window.deleteBudgetItem = deleteBudgetItem;

function updateBudgetModalAssigneeNames() {
  const s = state.settings;
  $('bm-assignee-p1').textContent = '👤 ' + (s.name1 || 'Pasangan 1');
  $('bm-assignee-p2').textContent = '👤 ' + (s.name2 || 'Pasangan 2');
}

/* ══════════════════════════════════════════
   TRANSACTION MODAL
══════════════════════════════════════════ */

/* ── Goal field di transaksi tabungan ── */
function updateTxGoalField(type) {
  const field = $('tx-goal-field');
  const sel   = $('tx-goal-select');
  if (!field || !sel) return;

  const show = (type === 'savings' || type === 'investments') && (state.goals || []).length > 0;
  field.style.display = show ? '' : 'none';

  if (show) {
    sel.innerHTML = '<option value="">— Tidak terkait goal —</option>' +
      (state.goals || []).map(g =>
        `<option value="${g.id}">${g.icon || '🎯'} ${g.name} (${fmt(g.saved)} / ${fmt(g.target)})</option>`
      ).join('');
  }
}

const TX_PLACEHOLDERS = {
  income:      'contoh: Gaji, Freelance, Transfer Masuk…',
  fixed:       'contoh: Sewa Rumah, Listrik, Internet…',
  variable:    'contoh: Makan Siang, Bensin, Belanja…',
  loan:        'contoh: Cicilan KPR, Bayar Paylater…',
  savings:     'contoh: Setor Tabungan, Dana Darurat…',
  investments: 'contoh: Beli Reksa Dana, Tambah Saham…',
};

function openAddTransaction(prefillType) {
  const today = new Date().toISOString().split('T')[0];
  const type = prefillType || 'income';
  $('tx-date').value     = today;
  $('tx-type').value     = type;
  $('tx-assignee').value = 'shared';
  $('tx-desc').value     = '';
  $('tx-amount').value   = '';
  $('tx-currency-prefix').textContent = state.settings.currency;
  $('tx-desc').placeholder = TX_PLACEHOLDERS[type] || 'contoh: Gaji, Belanja…';
  updateTxGoalField(type);
  updateTxAssigneeNames();
  populateTxDescriptionOptions();
  $('tx-modal').classList.remove('hidden');
  setTimeout(() => $('tx-amount').focus(), 100);
}
window.openAddTransaction = openAddTransaction;

function closeTxModal() { $('tx-modal').classList.add('hidden'); }

function updateTxAssigneeNames() {
  const s = state.settings;
  $('tx-assignee-p1').textContent = '👤 ' + (s.name1 || 'Pasangan 1');
  $('tx-assignee-p2').textContent = '👤 ' + (s.name2 || 'Pasangan 2');
}

function populateTxDescriptionOptions() {
  const type = $('tx-type').value;
  const asn  = $('tx-assignee').value;
  const items = state.budgetItems[type] || [];
  const relevant = items.filter(i => i.assignee === asn || asn === 'shared' || i.assignee === 'shared');
  const dl = document.getElementById('tx-desc-list');
  if (dl) dl.innerHTML = relevant.map(i => `<option value="${i.description}" data-id="${i.id}">`).join('');
}

function saveTransaction() {
  const date = $('tx-date').value;
  const type = $('tx-type').value;
  const asn  = $('tx-assignee').value;
  const desc = $('tx-desc').value.trim();
  const amt  = getRawValue($('tx-amount'));
  if (!desc) { showToast('Deskripsi tidak boleh kosong', 'error'); return; }
  if (amt <= 0) { showToast('Jumlah harus lebih dari 0', 'error'); return; }
  const items = state.budgetItems[type] || [];
  const matchedItem = items.find(i => i.description === desc && (i.assignee === asn || asn === 'shared'));
  const tx = { id: generateId(), budgetItemId: matchedItem?.id || null, date, type, assignee: asn, description: desc, amount: amt };
  state.transactions.unshift(tx);
  saveState();
  closeTxModal();
  showToast('Transaksi disimpan ✅');
  renderPage(currentPage);
}

async function deleteTx(id) {
  const idx = state.transactions.findIndex(t => t.id === id);
  if (idx < 0) return;
  const ok = await showConfirm('Hapus Transaksi?', 'Transaksi ini akan dihapus permanen.');
  if (!ok) return;
  state.transactions.splice(idx, 1);
  saveState();
  renderPage(currentPage);
  showToast('Transaksi dihapus', 'info');
}
window.deleteTx = deleteTx;

/* ══════════════════════════════════════════
   SETTINGS MODAL
══════════════════════════════════════════ */
function openSettings() {
  const s = state.settings;
  $('s-name1').value    = s.name1;
  $('s-name2').value    = s.name2;
  $('s-currency').value = s.currency;
  $('s-month').value    = s.month;
  $$('.theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === s.theme));
  $('settings-modal').classList.remove('hidden');
}
function closeSettings() { $('settings-modal').classList.add('hidden'); }

function saveSettings() {
  const s = state.settings;
  s.name1    = $('s-name1').value.trim() || s.name1;
  s.name2    = $('s-name2').value.trim() || s.name2;
  s.currency = $('s-currency').value;
  s.month    = $('s-month').value;
  saveState();
  applyTheme(s.theme);
  updateSidebarCouple();
  closeSettings();
  showToast('Pengaturan disimpan ✅');
  renderPage(currentPage);
}

function toggleTheme() {
  const themes = ['dark', 'yuki', 'rose', 'ocean'];
  const idx = themes.indexOf(state.settings.theme);
  applyTheme(themes[(idx + 1) % themes.length]);
  saveState();
}

function applyTheme(theme) {
  // Migrasi tema lama
  if (theme === 'light' || theme === 'sakura') theme = 'yuki';
  state.settings.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  $$('.theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === theme));
  const icons  = { dark: '🖤', yuki: '❄️', rose: '🩷', ocean: '🌊' };
  const labels = { dark: '🖤 Drako', yuki: '❄️ Yuki', rose: '🩷 Pupi', ocean: '🌊 Ocean' };
  const icon = icons[theme] || '🖤';
  const sidebarBtn = document.querySelector('#sidebar-theme-toggle');
  if (sidebarBtn) sidebarBtn.innerHTML = `<span id="sidebar-theme-icon">${icon}</span> ${labels[theme] || ''}`;
  const topbarIcon = $('topbar-theme-icon');
  if (topbarIcon) topbarIcon.textContent = icon;
  setTimeout(() => { renderDonutChart(); renderBarChart(); renderFinanceSticker(); }, 150);
}

/* ══════════════════════════════════════════
   FINANCE STICKER — kondisi keuangan → stiker
══════════════════════════════════════════ */
function getFinanceStickerConfig() {
  const incomeBudget  = calcBudget('income');
  const incomeActual  = calcActual('income');
  const expenseBudget = calcTotalBudget(EXPENSE_CATEGORIES);
  const expenseActual = calcTotalActual(EXPENSE_CATEGORIES);
  const savActual     = calcActual('savings') + calcActual('investments');
  const totalTx       = state.transactions.filter(t => {
    const m = state.settings.month;
    return !m || (t.date && t.date.substring(0,7) === m);
  }).length;
  const income = incomeActual || incomeBudget;
  const leftActual = incomeActual - expenseActual - savActual;
  const surplusPct = income > 0 ? leftActual / income : 0;
  const expRatio   = income > 0 ? expenseActual / income : 0;
  const goals      = state.goals || [];
  const goalDone   = goals.some(g => g.target > 0 && (g.saved || 0) >= g.target);

  // 0 data sama sekali
  if (totalTx === 0 && incomeBudget === 0) return {
    stickerNum: 9, cls: 'sticker--idle',
    title: 'Belum ada data nih~',
    desc: 'Yuk mulai catat keuangan kalian! 🐾'
  };

  // Goal tercapai (prioritas tinggi)
  if (goalDone) return {
    stickerNum: 17, cls: 'sticker--celebrate',
    title: 'Goal tercapai! 🎉',
    desc: 'Kalian luar biasa — target tabungan kelar!'
  };

  // Surplus besar > 30%
  if (surplusPct >= 0.30 && income > 0) return {
    stickerNum: 3, cls: '',
    title: 'Keuangan sehat banget!',
    desc: `Sisa ${Math.round(surplusPct*100)}% dari pemasukan 🌟`
  };

  // Keuangan sehat, surplus kecil 10-30%
  if (surplusPct >= 0.10 && income > 0) return {
    stickerNum: 12, cls: '',
    title: 'On track, good job!',
    desc: 'Pengeluaran terkendali ✅'
  };

  // Nabung konsisten
  if (savActual > 0 && expRatio < 0.80) return {
    stickerNum: 19, cls: '',
    title: 'Rajin nabung nih!',
    desc: 'Konsisten = kunci kebebasan finansial 🐟'
  };

  // Baru login / welcome
  if (totalTx === 0 && incomeBudget > 0) return {
    stickerNum: 4, cls: 'sticker--idle',
    title: 'Siap pantau keuangan~',
    desc: 'Anggaran sudah diset, yuk catat transaksi! 👀'
  };

  // Hampir overspend — expense 80-100%
  if (expRatio >= 0.80 && expRatio < 1.0) return {
    stickerNum: 14, cls: '',
    title: 'Hati-hati nih...',
    desc: `Pengeluaran udah ${Math.round(expRatio*100)}% dari budget ⚠️`
  };

  // Overspend / defisit
  if (expenseActual > expenseBudget && expenseBudget > 0) return {
    stickerNum: 20, cls: 'sticker--crisis',
    title: 'Aduh, over budget! 😭',
    desc: 'Pengeluaran melebihi anggaran — yuk evaluasi!'
  };

  // Pengeluaran variabel tinggi
  if (expRatio >= 0.70) return {
    stickerNum: 6, cls: '',
    title: 'Pengeluaran lumayan nih',
    desc: 'Kurangi sedikit biar lebih lega~'
  };

  // Default: aman
  return {
    stickerNum: 3, cls: '',
    title: 'Keuangan aman!',
    desc: 'Terus pertahankan ya 💪'
  };
}

function renderFinanceSticker() {
  const el = $('finance-sticker-area');
  if (!el) return;
  const { stickerNum, cls, title, desc } = getFinanceStickerConfig();
  el.innerHTML = `
    <div class="sticker-card">
      <div class="sticker sticker-${stickerNum} ${cls}"></div>
      <div class="sticker-card-text">
        <div class="sticker-card-title">${title}</div>
        <div class="sticker-card-desc">${desc}</div>
      </div>
    </div>
  `;
}

/* ══════════════════════════════════════════
   SIDEBAR
══════════════════════════════════════════ */
function updateSidebarCouple() {
  const s = state.settings;
  $('av1').textContent          = (s.name1[0] || '?').toUpperCase();
  $('av2').textContent          = (s.name2[0] || '?').toUpperCase();
  $('sidebar-name1').textContent = s.name1;
  $('sidebar-name2').textContent = s.name2;
  $('sidebar-month-badge').textContent = monthLabel(s.month);

  const filterP1 = $('filter-p1'); if (filterP1) filterP1.textContent = s.name1;
  const filterP2 = $('filter-p2'); if (filterP2) filterP2.textContent = s.name2;
  updateBudgetModalAssigneeNames();
  updateTxAssigneeNames();

  $('split-currency').textContent  = s.currency;
  const sl1 = $('split-label-p1'); if (sl1) sl1.textContent = s.name1;
  const sl2 = $('split-label-p2'); if (sl2) sl2.textContent = s.name2;
  const gc  = $('goal-currency');  if (gc) gc.textContent = s.currency;
  const gc2 = $('goal-currency2'); if (gc2) gc2.textContent = s.currency;
}

/* ══════════════════════════════════════════
   DATA MANAGEMENT
══════════════════════════════════════════ */
async function resetAllData() {
  const ok = await showConfirm('Reset Semua Data?', 'Semua data budget, transaksi, goals, dan pengaturan akan dihapus!', 'danger');
  if (!ok) return;
  state.budgetItems   = { income: [], fixed: [], variable: [], loan: [], savings: [], investments: [] };
  state.transactions  = [];
  state.goals         = [];
  state.splitHistory  = [];
  await saveToSupabase();
  renderPage(currentPage);
  showToast('Data direset', 'info');
}

async function resetMonthData() {
  const month = state.settings.month;
  const ok = await showConfirm(`Reset Data ${monthLabel(month)}?`, `Semua transaksi bulan ${monthLabel(month)} akan dihapus.`, 'danger');
  if (!ok) return;
  state.transactions = state.transactions.filter(t => t.date && t.date.substring(0, 7) !== month);
  saveState();
  closeSettings();
  renderPage(currentPage);
  showToast('Data bulan ini direset', 'info');
}

/* ══════════════════════════════════════════
   KEYBOARD SHORTCUTS
══════════════════════════════════════════ */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    ['tx-modal', 'budget-modal', 'settings-modal', 'confirm-modal', 'import-modal', 'goal-modal'].forEach(id => {
      const el = $(id);
      if (el && !el.classList.contains('hidden')) {
        if (id === 'confirm-modal' && confirmResolve) confirmResolve(false);
        el.classList.add('hidden');
      }
    });
  }
  if (e.key === 'Enter') {
    if (!$('tx-modal').classList.contains('hidden'))     { e.preventDefault(); saveTransaction(); }
    else if (!$('budget-modal').classList.contains('hidden')) { e.preventDefault(); saveBudgetItem(); }
  }
});




/* ══════════════════════════════════════════
   APP INIT
══════════════════════════════════════════ */
function initApp() {
  updateSidebarCouple();

  // Init number inputs dengan format titik otomatis
  ['tx-amount', 'bm-amount', 'goal-target', 'goal-saved', 'split-amount'].forEach(initNumberInput);


  // Sidebar overlay
  sidebarOverlay = document.createElement('div');
  sidebarOverlay.className = 'sidebar-overlay';
  document.body.appendChild(sidebarOverlay);
  sidebarOverlay.addEventListener('click', () => {
    $('sidebar').classList.remove('open');
    sidebarOverlay.classList.remove('show');
  });

  // Month picker di dashboard
  const dashMonthPicker = $('dash-month-picker');
  if (dashMonthPicker) {
    dashMonthPicker.value = state.settings.month || '';
    dashMonthPicker.addEventListener('change', () => {
      state.settings.month = dashMonthPicker.value;
      $('sidebar-month-badge').textContent = monthLabel(state.settings.month);
      $('dash-month-label').textContent = monthLabel(state.settings.month);
      saveState();
      renderDashboard();
    });
  }

  // Tombol + Anggaran (context-aware: muncul hanya di halaman kategori)
  const addBudgetBtn = $('add-budget-btn');
  if (addBudgetBtn) {
    addBudgetBtn.addEventListener('click', () => {
      openAddBudgetItem(currentPage);
    });
  }

  // Nav
  $$('.nav-item').forEach(btn => btn.addEventListener('click', () => navigateTo(btn.dataset.page)));

  // Mobile menu
  $('menu-toggle').addEventListener('click', () => {
    $('sidebar').classList.toggle('open');
    sidebarOverlay.classList.toggle('show');
  });

  // Topbar & sidebar actions
  $('see-all-tx').addEventListener('click',      () => navigateTo('transactions'));
  $('add-tx-btn').addEventListener('click',       () => openAddTransaction());
  $('add-tx-btn2').addEventListener('click',      () => openAddTransaction());
  $('open-settings').addEventListener('click',   openSettings);
  $('topbar-settings').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click',  closeSettings);
  $('settings-cancel').addEventListener('click', closeSettings);
  $('settings-save').addEventListener('click',   saveSettings);
  $('sidebar-theme-toggle').addEventListener('click', toggleTheme);
  $('topbar-theme-toggle').addEventListener('click', toggleTheme);
  $$('.theme-btn').forEach(btn => btn.addEventListener('click', () => applyTheme(btn.dataset.theme)));

  // TX modal
  $('tx-close').addEventListener('click',  closeTxModal);
  $('tx-cancel').addEventListener('click', closeTxModal);
  $('tx-save').addEventListener('click',   saveTransaction);
  $('tx-type').addEventListener('change', () => {
    const type = $('tx-type').value;
    $('tx-desc').placeholder = TX_PLACEHOLDERS[type] || 'contoh: Gaji, Belanja…';
    updateTxGoalField(type);
    populateTxDescriptionOptions();
  });
  $('tx-assignee').addEventListener('change', populateTxDescriptionOptions);

  // Budget modal
  $('bm-close').addEventListener('click',  closeBudgetModal);
  $('bm-cancel').addEventListener('click', closeBudgetModal);
  $('bm-save').addEventListener('click',   saveBudgetItem);

  // Add item buttons
  $$('.add-item-btn').forEach(btn => btn.addEventListener('click', () => openAddBudgetItem(btn.dataset.category)));

  // Filters
  ['filter-type', 'filter-assignee', 'filter-search', 'sort-tx'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('input', () => { if (currentPage === 'transactions') renderTransactionsPage(); });
  });

  // Data management
  $('export-btn')?.addEventListener('click',      exportData);
  $('dash-export-btn').addEventListener('click',  exportData);
  $('sidebar-export-btn').addEventListener('click', exportData);
  $('import-file').addEventListener('change',     e => handleImportFile(e.target.files[0]));
  $('reset-btn').addEventListener('click',        resetAllData);
  $('reset-month-btn').addEventListener('click',  resetMonthData);
  $('import-cancel-btn').addEventListener('click', () => { $('import-modal').classList.add('hidden'); pendingImportData = null; });
  $('import-modal-close').addEventListener('click', () => { $('import-modal').classList.add('hidden'); pendingImportData = null; });
  $('import-confirm-btn').addEventListener('click', () => {
    if (pendingImportData) {
      state = deepMerge(state, pendingImportData);
      saveState();
      applyTheme(state.settings.theme);
      updateSidebarCouple();
      $('import-modal').classList.add('hidden');
      showToast('Data berhasil diimpor ✅');
      renderPage(currentPage);
      pendingImportData = null;
    }
  });

  // Close modals on overlay click
  [$('tx-modal'), $('budget-modal'), $('settings-modal'), $('goal-modal')].forEach(modal => {
    if (modal) modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden'); });
  });

  // Auto-detect theme
  if (!state.settings.theme) {
    state.settings.theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  applyTheme(state.settings.theme);
  navigateTo('dashboard');
}


/* ══════════════════════════════════════════
   NUMBER INPUT FORMATTING — titik otomatis
══════════════════════════════════════════ */
function formatNumberInput(input) {
  // Ambil nilai, hapus semua non-digit
  let raw = input.value.replace(/[^0-9]/g, '');
  if (!raw) { input.value = ''; input.dataset.rawValue = '0'; return; }
  // Simpan raw value di dataset
  input.dataset.rawValue = raw;
  // Format dengan titik tiap 3 digit
  input.value = parseInt(raw, 10).toLocaleString('id-ID');
}

function getRawValue(input) {
  // Ambil angka asli tanpa titik
  return parseFloat((input.dataset.rawValue || input.value.replace(/[^0-9]/g, '')) || '0') || 0;
}

function initNumberInput(inputId) {
  const el = $(inputId);
  if (!el) return;
  el.setAttribute('type', 'text');
  el.setAttribute('inputmode', 'numeric');
  el.setAttribute('autocomplete', 'off');
  el.addEventListener('input', () => {
    const pos = el.selectionStart;
    const oldLen = el.value.length;
    formatNumberInput(el);
    // Adjust cursor position after formatting
    const newLen = el.value.length;
    el.selectionStart = el.selectionEnd = Math.max(0, pos + (newLen - oldLen));
  });
  el.addEventListener('focus', () => {
    if (el.value === '0') el.value = '';
  });
  el.addEventListener('blur', () => {
    formatNumberInput(el);
    if (el.dataset.rawValue === '0' || !el.dataset.rawValue) el.value = '';
  });
}

/* ══════════════════════════════════════════
   BOOTSTRAP
══════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  // Init Supabase — harus di sini supaya CDN sudah siap
  try {
    const { createClient } = window.supabase;
    sbClient = createClient(SUPABASE_URL, SUPABASE_KEY);
  } catch(e) {
    console.error('Supabase gagal load:', e);
  }

  // Init auth tab listeners
  initAuthTabs();

  // Init semua event listeners
  initAllListeners();

  // Check invite link first
  const isInvite = await checkInviteLink();
  if (isInvite) return;

  // Try restore session
  const restored = await restoreSession();
  if (!restored) {
    // Show auth screen
    $('auth-screen').classList.remove('hidden');
  }
});
