import { BANK_CATALOG } from './catalog';
import type {
  AppCatalog,
  AppState,
  Bank,
  ExpenseKind,
  Investment,
  SavingsGoalId,
  Transaction,
  TxnStatus,
  TxnType,
  ViewId,
} from './types';
import { isExpenseKind, isSavingsGoalId, isTxnType, isViewId, SAVINGS_GOAL_IDS } from './types';
import {
  FINANCE_STORAGE_KEY,
  clearSessionAuth,
  createAuthAndEncryptFirstTime,
  decryptToPlaintext,
  encryptPlaintext,
  getSessionKeyMaterial,
  hasPasswordProtection,
  removePasswordProtection,
  verifyPasswordAndStoreSession,
} from './auth-storage';

const DEFAULT_CATALOG: AppCatalog = {
  incomeCategories: ['Salário', 'Aluguel', 'Bonificação', 'Freelance', 'Vendas online', 'Vendas físicas', 'Doação'],
  expenseCategories: [
    'Alimentação',
    'Casa',
    'Cartão de Crédito',
    'Educação',
    'Financiamentos',
    'Impostos',
    'Internet',
    'Investimento',
    'Transporte',
    'Saúde',
    'Outros',
    'Despesas Pessoais',
  ],
  investmentTypes: ['Poupança', 'CDB', 'Renda fixa', 'Fundo imobiliário', 'Ações', 'CDI'],
};

const EMPTY_SAVINGS_GOALS: AppState['savingsGoals'] = {
  carro: { target: 0, saved: 0 },
  casa: { target: 0, saved: 0 },
  apartamento: { target: 0, saved: 0 },
  celular: { target: 0, saved: 0 },
  consorcio: { target: 0, saved: 0 },
};

const SIDEBAR_COLLAPSED_KEY = 'sculacho.sidebarCollapsed';

const defaultData: AppState = {
  banks: [],
  transactions: [],
  investments: [],
  catalog: structuredClone(DEFAULT_CATALOG),
  annualPatrimonyGoal: 0,
  annualInvestmentGoal: 0,
  savingsGoals: structuredClone(EMPTY_SAVINGS_GOALS),
  monthlyBudgets: {},
};

function mergeSavingsGoals(raw: unknown): AppState['savingsGoals'] {
  const out = structuredClone(EMPTY_SAVINGS_GOALS);
  if (!raw || typeof raw !== 'object') return out;
  const o = raw as Record<string, { target?: unknown; saved?: unknown }>;
  for (const id of SAVINGS_GOAL_IDS) {
    const e = o[id];
    if (!e || typeof e !== 'object') continue;
    const t = e.target;
    const s = e.saved;
    if (typeof t === 'number' && Number.isFinite(t) && t >= 0) out[id].target = t;
    if (typeof s === 'number' && Number.isFinite(s) && s >= 0) out[id].saved = s;
  }
  return out;
}

function uniqueStrings(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  const s = arr
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    .filter(Boolean);
  return [...new Set(s)];
}

function normalizeBudgetMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = key.trim();
    if (!name) continue;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      out[name] = Math.round(value * 100) / 100;
    }
  }
  return out;
}

function normalizeImportedState(o: Record<string, unknown>): AppState {
  const banks = Array.isArray(o.banks) ? (o.banks as Bank[]) : [];
  const rawTx = Array.isArray(o.transactions) ? (o.transactions as Transaction[]) : [];
  const transactions = rawTx.map((t) => ({
    ...t,
    bankId: typeof t.bankId === 'string' ? t.bankId : '',
  }));
  const rawInv = Array.isArray(o.investments) ? (o.investments as Investment[]) : [];
  const investments = rawInv.map((inv) => {
    const g = inv.savingsGoalId;
    if (typeof g === 'string' && isSavingsGoalId(g)) return inv;
    const { savingsGoalId: _x, ...rest } = inv;
    return rest as Investment;
  });
  const rawCat = o.catalog as Record<string, unknown> | undefined;
  const inc = uniqueStrings(rawCat?.incomeCategories);
  const exp = uniqueStrings(rawCat?.expenseCategories);
  const invt = uniqueStrings(rawCat?.investmentTypes);
  const catalog: AppCatalog = {
    incomeCategories: inc.length ? inc : [...DEFAULT_CATALOG.incomeCategories],
    expenseCategories: exp.length ? exp : [...DEFAULT_CATALOG.expenseCategories],
    investmentTypes: invt.length ? invt : [...DEFAULT_CATALOG.investmentTypes],
  };
  const gRaw = o.annualPatrimonyGoal;
  let annualPatrimonyGoal = 0;
  if (typeof gRaw === 'number' && Number.isFinite(gRaw) && gRaw >= 0) annualPatrimonyGoal = gRaw;
  const invGoalRaw = o.annualInvestmentGoal;
  let annualInvestmentGoal = 0;
  if (typeof invGoalRaw === 'number' && Number.isFinite(invGoalRaw) && invGoalRaw >= 0) {
    annualInvestmentGoal = invGoalRaw;
  }
  const savingsGoals = mergeSavingsGoals(o.savingsGoals);
  const monthlyBudgets = normalizeBudgetMap(o.monthlyBudgets);
  return {
    banks,
    transactions,
    investments,
    catalog,
    annualPatrimonyGoal,
    annualInvestmentGoal,
    savingsGoals,
    monthlyBudgets,
  };
}

function getEl<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Elemento #${id} não encontrado`);
  return el as T;
}

let state: AppState = structuredClone(defaultData);
type CashflowFilter = 'all' | 'payable' | 'receivable' | 'overdue' | 'investments';
let cashflowFilter: CashflowFilter = 'all';
type CsvImportRow = { tx: Transaction; duplicate: boolean; rawDescription: string };
let pendingCsvImport: CsvImportRow[] = [];

async function loadStateFromDisk(): Promise<AppState> {
  const raw = localStorage.getItem(FINANCE_STORAGE_KEY);
  if (!raw) return structuredClone(defaultData);
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return structuredClone(defaultData);
    const o = parsed as Record<string, unknown>;
    if (o._enc === 'v1' && typeof o.iv === 'string' && typeof o.data === 'string') {
      const key = getSessionKeyMaterial();
      if (!key) return structuredClone(defaultData);
      const plain = await decryptToPlaintext(o.iv, o.data, key);
      const inner = JSON.parse(plain) as unknown;
      if (typeof inner !== 'object' || inner === null) return structuredClone(defaultData);
      return normalizeImportedState(inner as Record<string, unknown>);
    }
    return normalizeImportedState(o);
  } catch {
    return structuredClone(defaultData);
  }
}

let saveChain = Promise.resolve();

function saveState(): void {
  saveChain = saveChain.then(() => persistStateAsync()).catch(() => {});
}

async function persistStateAsync(): Promise<void> {
  const plain = JSON.stringify(state);
  if (hasPasswordProtection()) {
    const key = getSessionKeyMaterial();
    if (!key) return;
    const { iv, data } = await encryptPlaintext(plain, key);
    localStorage.setItem(FINANCE_STORAGE_KEY, JSON.stringify({ _enc: 'v1', iv, data }));
  } else {
    localStorage.setItem(FINANCE_STORAGE_KEY, plain);
  }
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function brl(v: number | string | undefined): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v ?? 0));
}

/** Valor para o campo de texto (ex.: 10000 → "10.000,00"). */
function formatMoneyInputBR(n: number): string {
  if (!Number.isFinite(n)) return '';
  return new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

/**
 * Interpreta valor como no Brasil: milhares com "." e decimais com "," (ex.: 10.000,00 → 10000).
 * Também aceita só "10000", "10.000" (milhar) ou "10,5".
 */
function parseMoneyBRL(raw: string): number {
  let s = raw.trim().replace(/\s/g, '');
  if (!s) return NaN;
  s = s.replace(/^R\$\s?/i, '');
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) {
    return Number(s.replace(/\./g, '').replace(',', '.'));
  }
  if (hasComma) {
    return Number(s.replace(/\./g, '').replace(',', '.'));
  }
  if (hasDot) {
    const parts = s.split('.');
    if (parts.length > 2) {
      return Number(parts.join(''));
    }
    if (parts.length === 2 && parts[1].length === 3 && /^\d+$/.test(parts[0]) && /^\d{3}$/.test(parts[1])) {
      return Number(parts[0] + parts[1]);
    }
    return Number(s);
  }
  return Number(s);
}

/** Converte texto do utilizador (formato BR) em valor monetário ≥ 0, com 2 casas. */
function moneyAmountFromUserInput(raw: string): number {
  const s = raw.trim();
  if (!s) return 0;
  const n = parseMoneyBRL(s);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100) / 100;
}

function parseCsvMoney(raw: string): number {
  const normalized = raw.replace(/[^\d,.\-()]/g, '').trim();
  if (!normalized) return NaN;
  const negative = normalized.startsWith('-') || (normalized.startsWith('(') && normalized.endsWith(')'));
  const cleaned = normalized.replace(/[()]/g, '').replace(/^-/, '');
  const value = parseMoneyBRL(cleaned);
  if (!Number.isFinite(value)) return NaN;
  return negative ? -Math.abs(value) : value;
}

function dateBR(v: string | undefined): string {
  if (!v) return '-';
  const [y, m, d] = v.split('-');
  return `${d}/${m}/${y}`;
}

function esc(s: string | number | undefined | null): string {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function typeLabel(type: TxnType): string {
  return type === 'entrada' ? 'Receita' : 'Despesa';
}

/** Classes do rótulo Tipo (Receita / Despesa / Investimento) nas listagens. */
function launchTypeTagClass(kind: TxnType | 'investimento'): string {
  if (kind === 'entrada') return 'tag tag-receita';
  if (kind === 'saida') return 'tag tag-despesa';
  return 'tag tag-investimento';
}

function statusLabel(status: TxnStatus | undefined): string {
  if (!status) return '—';
  const map: Record<TxnStatus, string> = {
    recebido: 'Recebido',
    a_receber: 'À receber',
    em_atraso: 'Em atraso',
    pago: 'Pago',
    a_vencer: 'A vencer',
    agendado: 'Agendado',
  };
  return map[status] ?? '—';
}

function expenseKindLabel(kind: ExpenseKind | undefined): string {
  if (!kind) return '—';
  return kind === 'fixa' ? 'Fixa' : 'Variável';
}

function parseTxnStatus(type: TxnType, raw: string): TxnStatus | undefined {
  const v = raw.trim();
  if (!v) return undefined;
  if (type === 'entrada') {
    if (v === 'recebido' || v === 'a_receber' || v === 'em_atraso') return v;
    return undefined;
  }
  if (v === 'pago' || v === 'a_vencer' || v === 'em_atraso' || v === 'agendado') return v;
  return undefined;
}

function fillTxnStatusSelect(type: TxnType): void {
  const sel = getEl<HTMLSelectElement>('txnStatus');
  if (type === 'entrada') {
    sel.innerHTML =
      '<option value="">—</option><option value="recebido">Recebido</option><option value="a_receber">À receber</option><option value="em_atraso">Em atraso</option>';
  } else {
    sel.innerHTML =
      '<option value="">—</option><option value="pago">Pago</option><option value="a_vencer">A vencer</option><option value="em_atraso">Em atraso</option><option value="agendado">Agendado</option>';
  }
}

function txnModalTypeOptionsHtml(three: boolean): string {
  const base =
    '<option value="entrada">Receita</option><option value="saida">Despesa</option>';
  return three ? `${base}<option value="investimento">Investimento</option>` : base;
}

function getTxnModalMode(): 'entrada' | 'saida' | 'investimento' {
  const v = getEl<HTMLSelectElement>('txnType').value;
  if (v === 'investimento') return 'investimento';
  if (isTxnType(v)) return v;
  return 'entrada';
}

function syncTxnFormUI(keepStatus?: TxnStatus): void {
  const mode = getTxnModalMode();
  const dueWrap = getEl('txnDueDateWrap');
  const expenseWrap = getEl('txnExpenseKindWrap');
  const statusWrap = getEl('txnStatusWrap');
  const catWrap = getEl('txnCategoryWrap');
  const methodWrap = getEl('txnMethodWrap');
  const invWrap = getEl('txnUnifiedInvWrap');
  const bankLbl = getEl('txnBankLabel');
  const sub = getEl('txnModalSubtitle');
  const descLbl = getEl('txnDescriptionLabel');

  if (mode === 'investimento') {
    dueWrap.classList.add('hidden');
    getEl<HTMLInputElement>('txnDueDate').removeAttribute('required');
    expenseWrap.classList.add('hidden');
    statusWrap.classList.add('hidden');
    catWrap.classList.add('hidden');
    methodWrap.classList.add('hidden');
    invWrap.classList.remove('hidden');
    getEl('txnBankWrap').classList.remove('hidden');
    getEl<HTMLSelectElement>('txnBank').setAttribute('required', 'required');
    bankLbl.textContent = 'Banco / conta do investimento';
    sub.textContent =
      'Como na planilha: tipo de investimento (lista do menu Cadastros), banco onde foi aplicado, valor e data.';
    descLbl.textContent = 'Observações (opcional)';
    refreshInvTypeDatalist();
    return;
  }

  invWrap.classList.add('hidden');
  catWrap.classList.remove('hidden');
  methodWrap.classList.remove('hidden');
  statusWrap.classList.remove('hidden');

  const type = mode;
  dueWrap.classList.remove('hidden');
  getEl<HTMLInputElement>('txnDueDate').setAttribute('required', 'required');
  if (type === 'entrada') {
    expenseWrap.classList.add('hidden');
    getEl<HTMLSelectElement>('txnExpenseKind').value = '';
    if (state.banks.length) {
      getEl('txnBankWrap').classList.remove('hidden');
      bankLbl.textContent = 'Banco / conta creditada';
      getEl<HTMLSelectElement>('txnBank').setAttribute('required', 'required');
    } else {
      getEl('txnBankWrap').classList.add('hidden');
      getEl<HTMLSelectElement>('txnBank').removeAttribute('required');
    }
    sub.textContent =
      'Receitas: indique a conta creditada, data do lançamento, classificação, valor, status e forma de pagamento. A data de vencimento é obrigatória (ex.: quando o crédito cai na conta).';
    descLbl.textContent = 'Descrição';
  } else {
    getEl('txnBankWrap').classList.remove('hidden');
    bankLbl.textContent = 'Banco / conta debitada';
    getEl<HTMLSelectElement>('txnBank').setAttribute('required', 'required');
    expenseWrap.classList.remove('hidden');
    sub.textContent =
      'Despesas: escolha a conta debitada, data de vencimento obrigatória, classificação, tipo fixo ou variável, valor, status e forma de pagamento.';
    descLbl.textContent = 'Descrição';
  }

  fillTxnStatusSelect(type);
  const statusSel = getEl<HTMLSelectElement>('txnStatus');
  const pickDefault = () => (type === 'entrada' ? 'recebido' : 'pago');
  if (keepStatus !== undefined) {
    statusSel.value = keepStatus;
    const ok =
      type === 'entrada'
        ? keepStatus === 'recebido' || keepStatus === 'a_receber' || keepStatus === 'em_atraso'
        : keepStatus === 'pago' || keepStatus === 'a_vencer' || keepStatus === 'em_atraso' || keepStatus === 'agendado';
    if (!ok) statusSel.value = pickDefault();
  } else {
    statusSel.value = pickDefault();
  }
}

function toast(message: string, type?: 'success' | 'error'): void {
  const host = document.getElementById('toastHost');
  if (!host) return;
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ` ${type}` : '');
  el.textContent = message;
  host.appendChild(el);
  const t = window.setTimeout(() => {
    el.remove();
  }, 4200);
  el.addEventListener('click', () => {
    window.clearTimeout(t);
    el.remove();
  });
}

/** Rótulo em selects: instituição + tipo de conta (+ observação) para distinguir cadastros repetidos. */
function bankOptionLabel(b: Bank): string {
  const name = (b.name ?? '').trim() || 'Sem nome';
  const tipo = (b.accountType ?? '').trim() || 'Sem tipo';
  const note = (b.note ?? '').trim();
  if (!note) return `${name} — ${tipo}`;
  const short = note.length > 56 ? `${note.slice(0, 56)}…` : note;
  return `${name} — ${tipo} · ${short}`;
}

/** Só o nome da instituição (células compactas, ex. Resumo por banco). */
function bankInstitutionDisplayName(b: Bank): string {
  const n = (b.name ?? '').trim();
  return n || 'Sem nome';
}

/** Detalhe completo da conta para tooltip (observação sem truncar). */
function bankFullDetailLabel(b: Bank): string {
  const name = (b.name ?? '').trim() || 'Sem nome';
  const tipo = (b.accountType ?? '').trim() || 'Sem tipo';
  const note = (b.note ?? '').trim();
  if (!note) return `${name} — ${tipo}`;
  return `${name} — ${tipo} · ${note}`;
}

function bankLabelById(id: string | undefined | null): string {
  if (id == null || id === '') return '—';
  const b = state.banks.find((x) => x.id === id);
  return b ? bankOptionLabel(b) : '—';
}

/** Célula de banco compacta: só o nome da instituição + tooltip com detalhe completo. */
function bankCellCompactHtml(id: string | undefined | null): string {
  if (id == null || id === '') return '—';
  const b = state.banks.find((x) => x.id === id);
  if (!b) return '—';
  return `<span class="bank-summary-name" title="${esc(bankFullDetailLabel(b))}">${esc(bankInstitutionDisplayName(b))}</span>`;
}

function savingsGoalDisplayName(id: SavingsGoalId | undefined | null): string {
  if (id == null || !isSavingsGoalId(id)) return '—';
  const labels: Record<SavingsGoalId, string> = {
    carro: 'Carro',
    casa: 'Casa',
    apartamento: 'Apartamento',
    celular: 'Celular',
    consorcio: 'Consórcio',
  };
  return labels[id];
}

function transactionsFiltered(): Transaction[] {
  return [...state.transactions].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}

function computeTotals(txns?: Transaction[]): { income: number; expense: number; balance: number } {
  const list = txns ?? state.transactions;
  const income = list.filter((t) => t.type === 'entrada').reduce((s, t) => s + Number(t.amount ?? 0), 0);
  const expense = list.filter((t) => t.type === 'saida').reduce((s, t) => s + Number(t.amount ?? 0), 0);
  return { income, expense, balance: income - expense };
}

function investmentAggForBank(bankId: string): { invested: number; invCount: number } {
  let invested = 0;
  let invCount = 0;
  for (const inv of state.investments) {
    if (resolveInvestmentBankId(inv) === bankId) {
      invested += Number(inv.amount ?? 0);
      invCount += 1;
    }
  }
  return { invested, invCount };
}

function bankSummaries(): {
  bank: Bank;
  income: number;
  expense: number;
  balance: number;
  invested: number;
  txnCount: number;
  invCount: number;
  count: number;
}[] {
  return state.banks
    .map((bank) => {
      const txns = state.transactions.filter((t) => t.bankId === bank.id);
      const { income, expense, balance } = computeTotals(txns);
      const { invested, invCount } = investmentAggForBank(bank.id);
      return {
        bank,
        income,
        expense,
        balance,
        invested,
        txnCount: txns.length,
        invCount,
        count: txns.length + invCount,
      };
    })
    .sort((a, b) => {
      const tb = b.balance + b.invested;
      const ta = a.balance + a.invested;
      if (tb !== ta) return tb - ta;
      return b.invested - a.invested;
    });
}

function categorySummaries(): { name: string; income: number; expense: number; total: number }[] {
  const map: Record<string, { name: string; income: number; expense: number }> = {};
  for (const t of state.transactions) {
    const key = (t.category ?? 'Sem categoria').trim() || 'Sem categoria';
    if (!map[key]) map[key] = { name: key, income: 0, expense: 0 };
    map[key][t.type === 'entrada' ? 'income' : 'expense'] += Number(t.amount ?? 0);
  }
  return Object.values(map)
    .map((i) => ({ ...i, total: i.income - i.expense }))
    .sort((a, b) => Math.abs(b.expense) - Math.abs(a.expense));
}

function totalInvestedPatrimony(): number {
  return state.investments.reduce((s, inv) => s + Number(inv.amount ?? 0), 0);
}

function resolveInvestmentBankId(inv: Investment): string {
  if (inv.bankId && state.banks.some((b) => b.id === inv.bankId)) return inv.bankId;
  const name = (inv.institution ?? '').trim();
  if (name) {
    const byName = state.banks.find((b) => b.name.trim() === name);
    if (byName) return byName.id;
  }
  return '';
}

/** Lançamentos (receita/despesa) + investimentos, mais recentes primeiro. */
type MergedCashRow = { kind: 'txn'; t: Transaction } | { kind: 'inv'; inv: Investment };

function mergedCashRowsSorted(): MergedCashRow[] {
  const tx = transactionsFiltered().map((t) => ({ kind: 'txn' as const, t }));
  const inv = [...state.investments]
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
    .map((i) => ({ kind: 'inv' as const, inv: i }));
  return [...tx, ...inv].sort((a, b) => {
    const da = a.kind === 'txn' ? a.t.date : a.inv.date;
    const db = b.kind === 'txn' ? b.t.date : b.inv.date;
    return (db ?? '').localeCompare(da ?? '');
  });
}

/** Totais de aportes por conta cadastrada + linha “sem vínculo” quando houver. */
function investmentsTotalsPerBank(): { bankId: string; name: string; total: number; count: number }[] {
  if (!state.banks.length) {
    const t = totalInvestedPatrimony();
    const n = state.investments.length;
    if (!n) return [];
    return [{ bankId: '', name: 'Cadastre bancos para ver por conta', total: t, count: n }];
  }
  const byId = new Map<string, { total: number; count: number }>();
  for (const b of state.banks) byId.set(b.id, { total: 0, count: 0 });
  let orphan = { total: 0, count: 0 };
  for (const inv of state.investments) {
    const bid = resolveInvestmentBankId(inv);
    if (bid && byId.has(bid)) {
      const cur = byId.get(bid)!;
      cur.total += Number(inv.amount ?? 0);
      cur.count += 1;
    } else {
      orphan.total += Number(inv.amount ?? 0);
      orphan.count += 1;
    }
  }
  const rows = state.banks.map((b) => {
    const v = byId.get(b.id)!;
    return { bankId: b.id, name: bankOptionLabel(b), total: v.total, count: v.count };
  });
  if (orphan.count > 0) rows.push({ bankId: '', name: 'Sem conta vinculada', ...orphan });
  return rows.sort((a, b) => b.total - a.total);
}

function investmentsYearTotal(year: number): number {
  const y = String(year);
  return state.investments.reduce((s, inv) => {
    const d = inv.date ?? '';
    return d.slice(0, 4) === y ? s + Number(inv.amount ?? 0) : s;
  }, 0);
}

/** Saldo dos lançamentos + soma dos aportes em investimentos. */
function totalConsolidatedPatrimony(): number {
  const { balance } = computeTotals();
  return balance + totalInvestedPatrimony();
}

function renderPatrimonyGoalStrip(): void {
  const total = totalConsolidatedPatrimony();
  getEl('kpiTotalPatrimony').textContent = brl(total);
  const year = new Date().getFullYear();
  const ytdInvested = investmentsYearTotal(year);
  const goal = Number(state.annualInvestmentGoal ?? 0);
  const goalEl = getEl('kpiGoalDisplay');
  const ytdEl = getEl('kpiGoalYtd');
  const yearEl = getEl('kpiGoalYear');
  const remainLabelEl = getEl('kpiGoalRemainLabel');
  const remainValueEl = getEl('kpiGoalRemainValue');
  const remainWrapEl = getEl('kpiGoalRemainWrap');
  const gapEl = getEl('kpiGoalGap');
  const fillEl = document.getElementById('kpiGoalProgressFill');
  yearEl.textContent = String(year);
  const setGoalProgressPct = (pct: number) => {
    if (fillEl instanceof HTMLElement) {
      fillEl.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    }
  };
  if (!goal || goal <= 0) {
    goalEl.textContent = '—';
    ytdEl.textContent = '—';
    remainLabelEl.textContent = 'Defina uma meta';
    remainValueEl.textContent = '—';
    remainWrapEl.className = 'kpi-hero-remain kpi-hero-remain--idle';
    gapEl.textContent =
      'Abra Investimentos e preencha «Meta de aportes no ano» para acompanhar o progresso aqui.';
    gapEl.className = 'kpi-hero-detail kpi-hero-detail--muted';
    setGoalProgressPct(0);
    return;
  }
  goalEl.textContent = brl(goal);
  ytdEl.textContent = brl(ytdInvested);
  setGoalProgressPct((ytdInvested / goal) * 100);
  const shortfall = goal - ytdInvested;
  if (shortfall > 0) {
    remainWrapEl.className = 'kpi-hero-remain';
    remainLabelEl.textContent = 'Falta para a meta';
    remainValueEl.textContent = brl(shortfall);
    remainValueEl.className = 'kpi-hero-remain-amount kpi-hero-remain-amount--short';
    gapEl.textContent = `Progresso: ${brl(ytdInvested)} de ${brl(goal)} neste ano.`;
    gapEl.className = 'kpi-hero-detail';
  } else {
    remainWrapEl.className = 'kpi-hero-remain kpi-hero-remain--ok';
    remainLabelEl.textContent = 'Acima da meta';
    remainValueEl.textContent = `+${brl(-shortfall)}`;
    remainValueEl.className = 'kpi-hero-remain-amount kpi-hero-remain-amount--ok';
    gapEl.textContent = 'Meta de aportes do ano cumprida. Parabéns pelo ritmo de investimento.';
    gapEl.className = 'kpi-hero-detail kpi-hero-detail--ok';
  }
}

function renderDashboardInsights(): void {
  const bankEl = document.getElementById('dashInsightBank');
  const flowEl = document.getElementById('dashInsightFlow');
  if (!bankEl || !flowEl) return;
  const sums = bankSummaries();
  if (sums.length) {
    const top = [...sums].sort((a, b) => {
      const tb = b.balance + b.invested;
      const ta = a.balance + a.invested;
      if (tb !== ta) return tb - ta;
      return b.balance - a.balance;
    })[0];
    const topTotal = top.balance + top.invested;
    bankEl.textContent =
      top.txnCount + top.invCount > 0
        ? `${bankOptionLabel(top.bank)} — saldo total na conta ${brl(topTotal)}${top.invested > 0 && top.balance !== 0 ? ` (${brl(top.balance)} caixa + ${brl(top.invested)} aportes)` : ''}.`
        : 'Contas cadastradas; adicione lançamentos ou aportes para preencher os saldos por banco.';
  } else {
    bankEl.textContent = 'Cadastre bancos e lançamentos para ver qual conta concentra mais saldo.';
  }
  const { income, expense, balance } = computeTotals();
  if (income === 0 && expense === 0) {
    flowEl.textContent = 'Ainda não há receitas nem despesas registadas.';
  } else {
    flowEl.textContent =
      balance >= 0
        ? `Entradas ${brl(income)} e saídas ${brl(expense)} — saldo de lançamentos ${brl(balance)}.`
        : `Entradas ${brl(income)} e saídas ${brl(expense)} — saldo de lançamentos ${brl(balance)}.`;
  }
}

function addDaysIso(baseIso: string, days: number): string {
  const d = new Date(`${baseIso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function currentMonthRange(): { start: string; end: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  return {
    start: new Date(y, m, 1, 12).toISOString().slice(0, 10),
    end: new Date(y, m + 1, 0, 12).toISOString().slice(0, 10),
  };
}

function dashboardDecisionItemHtml(kind: 'ok' | 'warn' | 'info', label: string, value: string, detail: string): string {
  return `<article class="decision-item decision-item--${kind}"><span class="decision-label">${esc(label)}</span><strong>${esc(value)}</strong><p>${esc(detail)}</p></article>`;
}

function renderDashboardDecisionCenter(): void {
  const container = document.getElementById('dashboardDecisionCenter');
  if (!container) return;
  const today = new Date().toISOString().slice(0, 10);
  const weekEnd = addDaysIso(today, 7);
  const { start: monthStart, end: monthEnd } = currentMonthRange();
  const { income, balance } = computeTotals();
  const monthTxns = state.transactions.filter((t) => {
    const d = t.dueDate || t.date || '';
    return d >= monthStart && d <= monthEnd;
  });
  const monthTotals = computeTotals(monthTxns);
  const monthInvested = state.investments
    .filter((inv) => (inv.date ?? '') >= monthStart && (inv.date ?? '') <= monthEnd)
    .reduce((s, inv) => s + Number(inv.amount ?? 0), 0);
  const projectedMonth = monthTotals.income - monthTotals.expense - monthInvested;
  const dueSoon = state.transactions.filter((t) => {
    if (t.type !== 'saida') return false;
    if (t.status === 'pago') return false;
    const d = t.dueDate || t.date || '';
    return d >= today && d <= weekEnd;
  });
  const dueSoonTotal = dueSoon.reduce((s, t) => s + Number(t.amount ?? 0), 0);
  const investedTotal = totalInvestedPatrimony();
  const investRate = income > 0 ? (investedTotal / income) * 100 : 0;
  const summaries = bankSummaries();
  const top = summaries[0];
  const topTotal = top ? top.balance + top.invested : 0;
  const consolidated = totalConsolidatedPatrimony();
  const concentrationPct = consolidated > 0 && top ? (Math.max(0, topTotal) / consolidated) * 100 : 0;
  const budgetRisk = budgetUsageRows().find((row) => row.pct >= 80);

  const items = [
    dashboardDecisionItemHtml(
      balance >= 0 ? 'ok' : 'warn',
      'Caixa atual',
      brl(balance),
      balance >= 0 ? 'Fluxo operacional positivo nos lançamentos.' : 'Saídas superam entradas registradas.'
    ),
    dashboardDecisionItemHtml(
      dueSoon.length ? 'warn' : 'ok',
      'Próximos 7 dias',
      dueSoon.length ? brl(dueSoonTotal) : 'Sem alertas',
      dueSoon.length ? `${dueSoon.length} compromisso(s) a vencer no período.` : 'Nenhuma despesa pendente encontrada.'
    ),
    dashboardDecisionItemHtml(
      projectedMonth >= 0 ? 'ok' : 'warn',
      'Projeção do mês',
      brl(projectedMonth),
      'Receitas menos despesas e aportes com data neste mês.'
    ),
    dashboardDecisionItemHtml(
      investRate >= 10 ? 'ok' : 'info',
      'Taxa de aporte',
      income > 0 ? `${Math.round(investRate)}%` : 'Sem base',
      income > 0 ? `${brl(investedTotal)} aportados sobre ${brl(income)} de entradas.` : 'Registre receitas para calcular o indicador.'
    ),
  ];

  if (top && top.txnCount + top.invCount > 0) {
    items.push(
      dashboardDecisionItemHtml(
        concentrationPct > 70 ? 'warn' : 'info',
        'Concentração',
        `${Math.round(concentrationPct)}%`,
        `${bankInstitutionDisplayName(top.bank)} concentra a maior posição consolidada.`
      )
    );
  }

  if (budgetRisk) {
    const over = budgetRisk.used - budgetRisk.limit;
    items.push(
      dashboardDecisionItemHtml(
        budgetRisk.pct >= 100 ? 'warn' : 'info',
        'Orcamento',
        `${Math.round(budgetRisk.pct)}%`,
        budgetRisk.pct >= 100
          ? `${budgetRisk.category} passou ${brl(Math.max(0, over))} do limite mensal.`
          : `${budgetRisk.category} ja consumiu ${brl(budgetRisk.used)} de ${brl(budgetRisk.limit)}.`
      )
    );
  }

  container.innerHTML = items.join('');
}

function renderKPIs(): void {
  const { income, expense, balance } = computeTotals();
  getEl('kpiBalance').textContent = brl(balance);
  getEl('kpiIncome').textContent = brl(income);
  getEl('kpiExpense').textContent = brl(expense);
  getEl('kpiInvested').textContent = brl(totalInvestedPatrimony());
  getEl('kpiCount').textContent = String(state.transactions.length + state.investments.length);
  renderPatrimonyGoalStrip();
  renderDashboardInsights();
  renderDashboardDecisionCenter();
}

function renderDashboardRecent(): void {
  const container = getEl('dashboardRecent');
  const items = mergedCashRowsSorted().slice(0, 8);
  if (!items.length) {
    container.innerHTML = '<div class="empty">Nenhum lançamento cadastrado ainda.</div>';
    return;
  }
  const rowHtml = (r: MergedCashRow): string => {
    if (r.kind === 'txn') {
      const t = r.t;
      return `<tr><td>${dateBR(t.date)}</td><td>${dateBR(t.dueDate)}</td><td>${bankCellCompactHtml(t.bankId)}</td><td>—</td><td>${esc(t.category ?? '-')}</td><td><span class="${launchTypeTagClass(t.type)}">${esc(typeLabel(t.type))}</span></td><td>${esc(statusLabel(t.status))}</td><td class="${t.type === 'entrada' ? 'positive' : 'negative'}">${brl(t.amount)}</td></tr>`;
    }
    const inv = r.inv;
    const bid = resolveInvestmentBankId(inv);
    return `<tr><td>${dateBR(inv.date)}</td><td>—</td><td>${bankCellCompactHtml(bid || undefined)}</td><td>${esc(savingsGoalDisplayName(inv.savingsGoalId))}</td><td>${esc(inv.type)}</td><td><span class="${launchTypeTagClass('investimento')}">Investimento</span></td><td>—</td><td class="kpi-invest-value">${brl(inv.amount)}</td></tr>`;
  };
  container.innerHTML =
    '<table><thead><tr><th>Data</th><th>Venc.</th><th>Banco</th><th>Meta</th><th>Categoria</th><th>Tipo</th><th>Status</th><th>Valor</th></tr></thead><tbody>' +
    items.map(rowHtml).join('') +
    '</tbody></table>';
}

function renderBankBars(): void {
  const container = getEl('bankBars');
  const summaries = bankSummaries();
  if (!summaries.length) {
    container.innerHTML = '<div class="empty">Cadastre pelo menos um banco.</div>';
    return;
  }
  const max = Math.max(...summaries.map((s) => Math.abs(s.balance + s.invested)), 1);
  container.innerHTML = summaries
    .map((s) => {
      const total = s.balance + s.invested;
      const w = total !== 0 ? Math.max((Math.abs(total) / max) * 100, 4) : 0;
      const breakdown =
        s.invested > 0 && s.balance !== 0
          ? `<div class="small muted" style="margin-top:4px">Caixa: <span class="${s.balance >= 0 ? 'positive' : 'negative'}">${brl(s.balance)}</span> · Aportes: <span class="kpi-invest-value">${brl(s.invested)}</span></div>`
          : '';
      return `<div><div style="display:flex;justify-content:space-between;gap:12px;margin-bottom:6px"><strong>${esc(bankOptionLabel(s.bank))}</strong><span class="${total >= 0 ? 'positive' : 'negative'}">${brl(total)}</span></div><div class="bar"><span style="width:${w}%"></span></div>${breakdown}</div>`;
    })
    .join('');
}

function txnDueKey(t: Transaction): string {
  return t.dueDate || t.date || '';
}

function isTxnPending(t: Transaction): boolean {
  if (t.type === 'entrada') return t.status !== 'recebido';
  return t.status !== 'pago';
}

function isTxnOverdue(t: Transaction, today = new Date().toISOString().slice(0, 10)): boolean {
  return isTxnPending(t) && txnDueKey(t) !== '' && txnDueKey(t) < today;
}

function cashflowRowsFiltered(): MergedCashRow[] {
  const today = new Date().toISOString().slice(0, 10);
  return mergedCashRowsSorted().filter((row) => {
    if (cashflowFilter === 'all') return true;
    if (cashflowFilter === 'investments') return row.kind === 'inv';
    if (row.kind !== 'txn') return false;
    const t = row.t;
    if (cashflowFilter === 'payable') return t.type === 'saida' && isTxnPending(t);
    if (cashflowFilter === 'receivable') return t.type === 'entrada' && isTxnPending(t);
    if (cashflowFilter === 'overdue') return isTxnOverdue(t, today);
    return true;
  });
}

function renderCashflowTabs(): void {
  document.querySelectorAll('[data-cashflow-filter]').forEach((el) => {
    const btn = el as HTMLButtonElement;
    const on = btn.dataset.cashflowFilter === cashflowFilter;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
  });
}

function renderCashflowSummary(): void {
  const container = document.getElementById('cashflowSummary');
  if (!container) return;
  const today = new Date().toISOString().slice(0, 10);
  const weekEnd = addDaysIso(today, 7);
  const pendingPayables = state.transactions.filter((t) => t.type === 'saida' && isTxnPending(t));
  const pendingReceivables = state.transactions.filter((t) => t.type === 'entrada' && isTxnPending(t));
  const overdue = state.transactions.filter((t) => isTxnOverdue(t, today));
  const dueWeek = pendingPayables.filter((t) => {
    const due = txnDueKey(t);
    return due >= today && due <= weekEnd;
  });
  const sum = (rows: Transaction[]) => rows.reduce((total, t) => total + Number(t.amount ?? 0), 0);
  const invested = totalInvestedPatrimony();
  container.innerHTML = [
    `<div class="cashflow-stat cashflow-stat--danger"><span>A pagar</span><strong>${brl(sum(pendingPayables))}</strong><p>${pendingPayables.length} compromisso(s) pendente(s)</p></div>`,
    `<div class="cashflow-stat cashflow-stat--success"><span>A receber</span><strong>${brl(sum(pendingReceivables))}</strong><p>${pendingReceivables.length} entrada(s) pendente(s)</p></div>`,
    `<div class="cashflow-stat cashflow-stat--warn"><span>Atrasados</span><strong>${brl(sum(overdue))}</strong><p>${overdue.length} item(ns) fora do prazo</p></div>`,
    `<div class="cashflow-stat cashflow-stat--info"><span>Prox. 7 dias</span><strong>${brl(sum(dueWeek))}</strong><p>${dueWeek.length} despesa(s) no periodo</p></div>`,
    `<div class="cashflow-stat cashflow-stat--invest"><span>Aportes</span><strong>${brl(invested)}</strong><p>${state.investments.length} registro(s) de investimento</p></div>`,
  ].join('');
}

function addMonthsIso(baseIso: string, months: number): string {
  if (!baseIso) return '';
  const d = new Date(`${baseIso}T12:00:00`);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() !== day) d.setDate(0);
  return d.toISOString().slice(0, 10);
}

function recurrenceKey(t: Transaction): string {
  const label = (t.description || t.category || t.method || '').trim().toLowerCase();
  const roundedAmount = Math.round(Number(t.amount ?? 0) / 10) * 10;
  return [t.type, label || 'sem-descricao', roundedAmount].join('|');
}

function renderCashflowRecurrences(): void {
  const container = document.getElementById('cashflowRecurrences');
  if (!container) return;
  const groups = new Map<string, Transaction[]>();
  for (const t of state.transactions) {
    const key = recurrenceKey(t);
    const list = groups.get(key) ?? [];
    list.push(t);
    groups.set(key, list);
  }
  const recurrences = [...groups.values()]
    .filter((items) => items.length >= 2)
    .map((items) => {
      const sorted = [...items].sort((a, b) => txnDueKey(b).localeCompare(txnDueKey(a)));
      const last = sorted[0];
      const avg = items.reduce((s, t) => s + Number(t.amount ?? 0), 0) / items.length;
      return {
        last,
        count: items.length,
        avg,
        next: addMonthsIso(txnDueKey(last), 1),
        label: (last.description || last.category || last.method || typeLabel(last.type)).trim(),
      };
    })
    .sort((a, b) => b.count - a.count || Math.abs(b.avg) - Math.abs(a.avg))
    .slice(0, 5);

  if (!recurrences.length) {
    container.innerHTML =
      '<div class="recurrence-head"><div><h3>Recorrencias detectadas</h3><p>O painel identifica padroes quando houver dois ou mais lancamentos parecidos.</p></div><span class="pill">Automacao</span></div>';
    return;
  }

  container.innerHTML =
    '<div class="recurrence-head"><div><h3>Recorrencias detectadas</h3><p>Padroes provaveis encontrados nos seus lancamentos. Use como base para revisar fixos, assinaturas e receitas recorrentes.</p></div><span class="pill">Automacao</span></div>' +
    `<div class="recurrence-list">${recurrences
      .map((r) => {
        const valueClass = r.last.type === 'entrada' ? 'positive' : 'negative';
        const next = r.next ? dateBR(r.next) : '-';
        return `<article class="recurrence-item"><div><strong>${esc(r.label)}</strong><p>${esc(typeLabel(r.last.type))} · ${r.count} ocorrencias · proxima estimativa ${esc(next)}</p></div><span class="${valueClass}">${brl(r.avg)}</span></article>`;
      })
      .join('')}</div>`;
}

function parseCsvRows(text: string): string[][] {
  const lines: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const firstLine = text.split(/\r?\n/).find((line) => line.trim()) ?? '';
  const delimiter = [';', ',', '\t'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"' && quoted && next === '"') {
      cell += '"';
      i++;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === delimiter && !quoted) {
      row.push(cell.trim());
      cell = '';
    } else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && next === '\n') i++;
      row.push(cell.trim());
      if (row.some(Boolean)) lines.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  row.push(cell.trim());
  if (row.some(Boolean)) lines.push(row);
  return lines;
}

function normalizeHeader(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function findCsvColumn(headers: string[], options: string[]): number {
  const normalized = headers.map(normalizeHeader);
  return normalized.findIndex((h) => options.some((opt) => h.includes(opt)));
}

function parseCsvDate(raw: string): string {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (!m) return '';
  const d = m[1].padStart(2, '0');
  const mo = m[2].padStart(2, '0');
  const y = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${y}-${mo}-${d}`;
}

function importedTxnDuplicate(tx: Transaction): boolean {
  const desc = (tx.description || '').trim().toLowerCase();
  return state.transactions.some(
    (t) =>
      t.type === tx.type &&
      t.date === tx.date &&
      Math.abs(Number(t.amount ?? 0) - Number(tx.amount ?? 0)) < 0.01 &&
      (t.description || '').trim().toLowerCase() === desc
  );
}

function parseCsvImport(text: string): CsvImportRow[] {
  const rows = parseCsvRows(text);
  if (rows.length < 2) return [];
  const headers = rows[0];
  const dataIdx = findCsvColumn(headers, ['data', 'date', 'lancamento']);
  const dueIdx = findCsvColumn(headers, ['vencimento', 'venc']);
  const descIdx = findCsvColumn(headers, ['descricao', 'descr', 'historico', 'memo', 'detalhe']);
  const amountIdx = findCsvColumn(headers, ['valor', 'amount', 'vlr']);
  const typeIdx = findCsvColumn(headers, ['tipo', 'type', 'natureza']);
  const catIdx = findCsvColumn(headers, ['categoria', 'category', 'classificacao']);
  const bankIdx = findCsvColumn(headers, ['banco', 'conta', 'bank']);
  if (dataIdx < 0 || amountIdx < 0) return [];
  return rows.slice(1).flatMap((cols): CsvImportRow[] => {
    const date = parseCsvDate(cols[dataIdx] ?? '');
    const amountRaw = parseCsvMoney(cols[amountIdx] ?? '');
    if (!date || !Number.isFinite(amountRaw) || amountRaw === 0) return [];
    const typeRaw = (cols[typeIdx] ?? '').toLowerCase();
    const type: TxnType =
      typeRaw.includes('entrada') || typeRaw.includes('receita') || typeRaw.includes('credito') || amountRaw > 0
        ? 'entrada'
        : 'saida';
    const description = (cols[descIdx] ?? '').trim();
    const category = (cols[catIdx] ?? '').trim();
    const bankText = (cols[bankIdx] ?? '').trim().toLowerCase();
    const bank = bankText ? state.banks.find((b) => bankOptionLabel(b).toLowerCase().includes(bankText) || b.name.toLowerCase().includes(bankText)) : undefined;
    const tx: Transaction = {
      id: uid(),
      bankId: bank?.id ?? '',
      type,
      amount: Math.abs(amountRaw),
      date,
      dueDate: dueIdx >= 0 ? parseCsvDate(cols[dueIdx] ?? '') || date : date,
      category,
      method: 'CSV',
      description,
      status: type === 'entrada' ? 'recebido' : 'pago',
    };
    return [{ tx, duplicate: importedTxnDuplicate(tx), rawDescription: description }];
  });
}

function renderCsvImportPreview(): void {
  const box = document.getElementById('csvImportPreview');
  if (!box) return;
  if (!pendingCsvImport.length) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  const newRows = pendingCsvImport.filter((r) => !r.duplicate);
  const dupRows = pendingCsvImport.length - newRows.length;
  box.classList.remove('hidden');
  box.innerHTML =
    `<div class="import-preview-head"><div><h3>Previa da importacao</h3><p>${newRows.length} novo(s) lancamento(s), ${dupRows} duplicado(s) ignorado(s).</p></div><div class="row-actions"><button type="button" class="btn primary" id="confirmCsvImport">Confirmar importacao</button><button type="button" class="btn ghost" id="cancelCsvImport">Cancelar</button></div></div>` +
    `<div class="table-wrap"><table><thead><tr><th>Status</th><th>Data</th><th>Tipo</th><th>Categoria</th><th>Descricao</th><th>Valor</th></tr></thead><tbody>${pendingCsvImport
      .slice(0, 12)
      .map((r) => `<tr><td>${r.duplicate ? 'Duplicado' : 'Novo'}</td><td>${dateBR(r.tx.date)}</td><td>${esc(typeLabel(r.tx.type))}</td><td>${esc(r.tx.category || '-')}</td><td>${esc(r.rawDescription || '-')}</td><td class="${r.tx.type === 'entrada' ? 'positive' : 'negative'}">${brl(r.tx.amount)}</td></tr>`)
      .join('')}</tbody></table></div>`;
}

function confirmCsvImport(): void {
  const rows = pendingCsvImport.filter((r) => !r.duplicate).map((r) => r.tx);
  if (!rows.length) {
    toast('Nenhum lancamento novo para importar.', 'error');
    return;
  }
  state.transactions.push(...rows);
  pendingCsvImport = [];
  renderAll();
  renderCsvImportPreview();
  toast(`${rows.length} lancamento(s) importado(s).`, 'success');
}

function cancelCsvImport(): void {
  pendingCsvImport = [];
  renderCsvImportPreview();
}

function renderTransactionsTable(): void {
  const container = getEl('transactionsTable');
  renderCashflowTabs();
  renderCashflowSummary();
  renderCashflowRecurrences();
  const merged = cashflowRowsFiltered();
  if (!merged.length) {
    container.innerHTML = '<div class="empty">Nenhum item encontrado para o filtro atual.</div>';
    return;
  }
  const rowHtml = (r: MergedCashRow): string => {
    if (r.kind === 'txn') {
      const t = r.t;
      return `<tr><td>${dateBR(t.date)}</td><td>${dateBR(t.dueDate)}</td><td>${esc(bankLabelById(t.bankId))}</td><td>—</td><td><span class="${launchTypeTagClass(t.type)}">${esc(typeLabel(t.type))}</span></td><td>${t.type === 'saida' ? esc(expenseKindLabel(t.expenseKind)) : '—'}</td><td>${esc(statusLabel(t.status))}</td><td>${esc(t.category ?? '-')}</td><td>${esc(t.description ?? '-')}</td><td>${esc(t.method ?? '-')}</td><td class="${t.type === 'entrada' ? 'positive' : 'negative'}">${brl(t.amount)}</td><td><div class="row-actions"><button type="button" class="btn ghost" data-edit-txn="${esc(t.id)}">Editar</button><button type="button" class="btn danger" data-delete-txn="${esc(t.id)}">Excluir</button></div></td></tr>`;
    }
    const inv = r.inv;
    const bid = resolveInvestmentBankId(inv);
    const desc = (inv.notes ?? '').trim() || inv.institution;
    return `<tr><td>${dateBR(inv.date)}</td><td>—</td><td>${esc(bankLabelById(bid || undefined))}</td><td>${esc(savingsGoalDisplayName(inv.savingsGoalId))}</td><td><span class="${launchTypeTagClass('investimento')}">Investimento</span></td><td>—</td><td>—</td><td>${esc(inv.type)}</td><td>${esc(desc)}</td><td>—</td><td class="kpi-invest-value">${brl(inv.amount)}</td><td><div class="row-actions"><button type="button" class="btn ghost" data-edit-inv="${esc(inv.id)}">Editar</button><button type="button" class="btn danger" data-delete-inv="${esc(inv.id)}">Excluir</button></div></td></tr>`;
  };
  const colgroup =
    '<colgroup>' +
    ['7%', '6%', '12%', '7%', '8%', '7%', '8%', '9%', '13%', '6%', '8%', '11%']
      .map((w) => `<col style="width:${w}" />`)
      .join('') +
    '</colgroup>';
  container.innerHTML =
    `<table class="table-launch">${colgroup}<thead><tr><th>Data</th><th>Venc.</th><th>Banco</th><th>Meta</th><th>Tipo</th><th>Natureza</th><th>Status</th><th>Cat.</th><th>Descr.</th><th>Forma</th><th>Valor</th><th>Ações</th></tr></thead><tbody>` +
    merged.map(rowHtml).join('') +
    '</tbody></table>';
}

function renderBanksList(): void {
  const container = getEl('banksList');
  if (!state.banks.length) {
    container.innerHTML = '<div class="empty">Nenhum banco cadastrado.</div>';
    return;
  }
  container.innerHTML = state.banks
    .map((b) => {
      const txns = state.transactions.filter((t) => t.bankId === b.id);
      const totals = computeTotals(txns);
      const { invested: invSum, invCount } = investmentAggForBank(b.id);
      const meta = [b.accountType ?? 'Sem tipo', b.code ? `Cód. ${b.code}` : '', b.note ?? ''].filter(Boolean).join(' · ');
      const movLine =
        invCount > 0
          ? `${txns.length} lanç. · ${invCount} aporte(s)`
          : `${txns.length} lançamento(s)`;
      const totalAtBank = totals.balance + invSum;
      const breakdown =
        invSum > 0 && totals.balance !== 0
          ? `<div class="small muted" style="margin-top:2px">Caixa: <span class="${totals.balance >= 0 ? 'positive' : 'negative'}">${brl(totals.balance)}</span> · Aportes: <span class="kpi-invest-value">${brl(invSum)}</span></div>`
          : '';
      return `<div class="bank-item"><div class="bank-item-main"><strong>${esc(b.name)}</strong><span class="muted small bank-item-meta" title="${esc(meta)}">${esc(meta)}</span></div><div class="bank-item-aside"><div><span class="${totalAtBank >= 0 ? 'positive' : 'negative'}">${brl(totalAtBank)}</span></div>${breakdown}<div class="small muted">${movLine}</div><div class="row-actions bank-item-actions"><button type="button" class="btn ghost" data-edit-bank="${esc(b.id)}">Editar</button><button type="button" class="btn danger" data-delete-bank="${esc(b.id)}">Excluir</button></div></div></div>`;
    })
    .join('');
}

function renderReports(): void {
  const byBank = getEl('reportByBank');
  const bankRows = bankSummaries();
  byBank.innerHTML = bankRows.length
    ? '<table><thead><tr><th>Banco</th><th>Entradas</th><th>Saídas</th><th>Saldo (caixa)</th><th>Investimentos</th><th>Itens</th></tr></thead><tbody>' +
      bankRows
        .map(
          (r) =>
            `<tr><td><span class="bank-summary-name" title="${esc(bankFullDetailLabel(r.bank))}">${esc(bankInstitutionDisplayName(r.bank))}</span></td><td class="positive">${brl(r.income)}</td><td class="negative">${brl(r.expense)}</td><td class="${r.balance >= 0 ? 'positive' : 'negative'}">${brl(r.balance)}</td><td class="kpi-invest-value">${brl(r.invested)}</td><td class="muted small">${r.txnCount} lanç. + ${r.invCount} aport.</td></tr>`
        )
        .join('') +
      '</tbody></table>'
    : '<div class="empty">Sem dados para exibir.</div>';

  const byCategory = getEl('reportByCategory');
  const catRows = categorySummaries();
  byCategory.innerHTML = catRows.length
    ? '<table><thead><tr><th>Categoria</th><th>Entradas</th><th>Saídas</th></tr></thead><tbody>' +
      catRows.map((r) => `<tr><td>${esc(r.name)}</td><td class="positive">${brl(r.income)}</td><td class="negative">${brl(r.expense)}</td></tr>`).join('') +
      '</tbody></table>'
    : '<div class="empty">Sem categorias para exibir.</div>';

  renderReportAnalysis();
}

const MONTH_LABELS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

const MONTH_NAMES_PT = [
  'Janeiro',
  'Fevereiro',
  'Março',
  'Abril',
  'Maio',
  'Junho',
  'Julho',
  'Agosto',
  'Setembro',
  'Outubro',
  'Novembro',
  'Dezembro',
];

/** Receitas e despesas: só entram por data de vencimento (sem usar data do lançamento). */
function txnVencimentoKey(t: Transaction): string | null {
  const d = t.dueDate?.trim();
  if (!d) return null;
  return d.length >= 10 ? d.slice(0, 10) : d;
}

/** Vista anual: totais por mês pela data de vencimento das receitas/despesas. */
function monthIncomeExpense(year: number, monthIndex0: number): { income: number; expense: number } {
  const mm = String(monthIndex0 + 1).padStart(2, '0');
  const prefix = `${year}-${mm}`;
  const txns = state.transactions.filter((t) => {
    const vk = txnVencimentoKey(t);
    return vk !== null && vk.startsWith(prefix);
  });
  const income = txns.filter((t) => t.type === 'entrada').reduce((s, t) => s + Number(t.amount ?? 0), 0);
  const expense = txns.filter((t) => t.type === 'saida').reduce((s, t) => s + Number(t.amount ?? 0), 0);
  return { income, expense };
}

/** Vista anual: aportes no mês pela data do investimento (aporte). */
function monthInvestmentsByAporte(year: number, monthIndex0: number): number {
  const mm = String(monthIndex0 + 1).padStart(2, '0');
  const prefix = `${year}-${mm}`;
  return state.investments
    .filter((inv) => (inv.date ?? '').startsWith(prefix))
    .reduce((s, inv) => s + Number(inv.amount ?? 0), 0);
}

function inYearMonthKey(dateKey: string, year: number, monthIndex0: number): boolean {
  if (!dateKey || dateKey.length < 7) return false;
  const mm = String(monthIndex0 + 1).padStart(2, '0');
  return dateKey.startsWith(`${year}-${mm}`);
}

function ensureReportYearOptions(): void {
  const sel = getEl<HTMLSelectElement>('reportYear');
  if (sel.options.length > 0) return;
  const y = new Date().getFullYear();
  for (let yy = y + 1; yy >= y - 10; yy--) {
    sel.add(new Option(String(yy), String(yy)));
  }
  sel.value = String(y);
}

function ensureReportMonthOptions(): void {
  const sel = getEl<HTMLSelectElement>('reportMonth');
  if (sel.options.length > 0) return;
  MONTH_NAMES_PT.forEach((name, i) => sel.add(new Option(name, String(i))));
  sel.value = String(new Date().getMonth());
}

function sortTxnsByVencimento(a: Transaction, b: Transaction): number {
  const ka = txnVencimentoKey(a);
  const kb = txnVencimentoKey(b);
  const c = (ka ?? '').localeCompare(kb ?? '');
  return c !== 0 ? c : (a.date ?? '').localeCompare(b.date ?? '');
}

function renderMonthlyDetailHtml(year: number, monthIndex0: number): string {
  const income = state.transactions.filter((t) => {
    if (t.type !== 'entrada') return false;
    const vk = txnVencimentoKey(t);
    return vk !== null && inYearMonthKey(vk, year, monthIndex0);
  });
  const expense = state.transactions.filter((t) => {
    if (t.type !== 'saida') return false;
    const vk = txnVencimentoKey(t);
    return vk !== null && inYearMonthKey(vk, year, monthIndex0);
  });
  const invs = state.investments.filter((inv) =>
    inYearMonthKey((inv.date ?? '').slice(0, 10), year, monthIndex0)
  );

  const incTotal = income.reduce((s, t) => s + Number(t.amount ?? 0), 0);
  const expTotal = expense.reduce((s, t) => s + Number(t.amount ?? 0), 0);
  const invTotal = invs.reduce((s, inv) => s + Number(inv.amount ?? 0), 0);

  const incRows = [...income]
    .sort(sortTxnsByVencimento)
    .map(
      (t) =>
        `<tr><td>${dateBR(txnVencimentoKey(t)!)}</td><td>${dateBR(t.date)}</td><td>${esc(t.category ?? '—')}</td><td class="positive">${brl(t.amount)}</td><td>${esc(bankLabelById(t.bankId))}</td><td>${esc(t.description || '—')}</td></tr>`
    )
    .join('');

  const expRows = [...expense]
    .sort(sortTxnsByVencimento)
    .map(
      (t) =>
        `<tr><td>${dateBR(txnVencimentoKey(t)!)}</td><td>${dateBR(t.date)}</td><td>${esc(expenseKindLabel(t.expenseKind))}</td><td>${esc(t.category ?? '—')}</td><td class="negative">${brl(t.amount)}</td><td>${esc(bankLabelById(t.bankId))}</td><td>${esc(t.description || '—')}</td></tr>`
    )
    .join('');

  const invRows = [...invs]
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))
    .map((inv) => {
      const bid = resolveInvestmentBankId(inv);
      const notes = (inv.notes ?? '').trim() || '—';
      return `<tr><td>${dateBR(inv.date)}</td><td>${esc(inv.type)}</td><td class="kpi-invest-value">${brl(inv.amount)}</td><td>${esc(inv.institution)}</td><td>${esc(bankLabelById(bid))}</td><td>${esc(savingsGoalDisplayName(inv.savingsGoalId))}</td><td>${esc(notes)}</td></tr>`;
    })
    .join('');

  const incHead =
    '<th>Venc.</th><th>Lançamento</th><th>Categoria</th><th>Valor</th><th>Banco</th><th>Descrição</th>';
  const expHead =
    '<th>Venc.</th><th>Lançamento</th><th>Natureza</th><th>Categoria</th><th>Valor</th><th>Banco</th><th>Descrição</th>';
  const invHead =
    '<th>Data do aporte</th><th>Tipo</th><th>Valor</th><th>Instituição</th><th>Banco</th><th>Meta</th><th>Notas</th>';

  const incFoot = incRows
    ? `<tfoot><tr><td colspan="3"><strong>Total</strong></td><td class="positive"><strong>${brl(incTotal)}</strong></td><td></td><td></td></tr></tfoot>`
    : '';
  const expFoot = expRows
    ? `<tfoot><tr><td colspan="4"><strong>Total</strong></td><td class="negative"><strong>${brl(expTotal)}</strong></td><td></td><td></td></tr></tfoot>`
    : '';
  const invFoot = invRows
    ? `<tfoot><tr><td colspan="2"><strong>Total aportes</strong></td><td class="kpi-invest-value"><strong>${brl(invTotal)}</strong></td><td colspan="4"></td></tr></tfoot>`
    : '';

  const block = (title: string, head: string, rows: string, emptyMsg: string, foot: string) =>
    rows
      ? `<div class="report-month-block"><h4>${esc(title)}</h4><div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody>${foot}</table></div></div>`
      : `<div class="report-month-block"><h4>${esc(title)}</h4><div class="empty">${emptyMsg}</div></div>`;

  return (
    block(
      'Receitas',
      incHead,
      incRows,
      'Nenhuma receita com data de vencimento neste mês.',
      incFoot
    ) +
    block(
      'Despesas',
      expHead,
      expRows,
      'Nenhuma despesa com data de vencimento neste mês.',
      expFoot
    ) +
    block(
      'Investimentos',
      invHead,
      invRows,
      'Nenhum investimento com data de aporte neste mês.',
      invFoot
    )
  );
}

function renderReportAnalysis(): void {
  ensureReportYearOptions();
  ensureReportMonthOptions();
  const box = getEl('reportMonthly');
  const year = Number(getEl<HTMLSelectElement>('reportYear').value) || new Date().getFullYear();
  const mode = getEl<HTMLSelectElement>('reportMode').value;
  const monthWrap = getEl('reportMonthWrap');
  const isMonthly = mode === 'monthly';
  monthWrap.classList.toggle('hidden', !isMonthly);

  if (!isMonthly) {
    const rows = MONTH_LABELS.map((label, mi) => {
      const { income, expense } = monthIncomeExpense(year, mi);
      const inv = monthInvestmentsByAporte(year, mi);
      const net = income - expense;
      return `<tr><td>${label}</td><td class="positive">${brl(income)}</td><td class="negative">${brl(expense)}</td><td class="kpi-invest-value">${brl(inv)}</td><td class="${net >= 0 ? 'positive' : 'negative'}">${brl(net)}</td></tr>`;
    });
    let yInc = 0;
    let yExp = 0;
    let yInv = 0;
    for (let mi = 0; mi < 12; mi++) {
      const m = monthIncomeExpense(year, mi);
      yInc += m.income;
      yExp += m.expense;
      yInv += monthInvestmentsByAporte(year, mi);
    }
    const yNet = yInc - yExp;
    box.innerHTML =
      '<div class="table-wrap"><table><thead><tr><th>Mês</th><th>Receitas</th><th>Despesas</th><th>Investimentos</th><th>Saldo do mês</th></tr></thead><tbody>' +
      rows.join('') +
      `<tr style="font-weight:700;border-top:2px solid var(--border)"><td>Total ${year}</td><td class="positive">${brl(yInc)}</td><td class="negative">${brl(yExp)}</td><td class="kpi-invest-value">${brl(yInv)}</td><td class="${yNet >= 0 ? 'positive' : 'negative'}">${brl(yNet)}</td></tr></tbody></table></div>`;
    return;
  }

  const mi = Number(getEl<HTMLSelectElement>('reportMonth').value);
  const monthIndex = !Number.isNaN(mi) && mi >= 0 && mi <= 11 ? mi : new Date().getMonth();
  const monthTitle = MONTH_NAMES_PT[monthIndex] ?? MONTH_NAMES_PT[0];
  box.innerHTML = `<p class="footer-note" style="margin-bottom:14px"><strong>${esc(monthTitle)} ${year}</strong> — receitas e despesas pela <strong>data de vencimento</strong>; investimentos pela <strong>data do aporte</strong>.</p>${renderMonthlyDetailHtml(year, monthIndex)}`;
}

function refreshTxnCategoryDatalist(): void {
  const dl = getEl<HTMLDataListElement>('txnCategoryList');
  if (getTxnModalMode() === 'investimento') {
    dl.innerHTML = '';
    return;
  }
  const type = getEl<HTMLSelectElement>('txnType').value;
  const items = type === 'saida' ? state.catalog.expenseCategories : state.catalog.incomeCategories;
  dl.innerHTML = items.map((c) => `<option value="${esc(c)}"></option>`).join('');
}

function refreshInvTypeDatalist(): void {
  const dl = getEl<HTMLDataListElement>('invTypeDatalist');
  dl.innerHTML = state.catalog.investmentTypes.map((c) => `<option value="${esc(c)}"></option>`).join('');
}

function renderCadastrosLists(): void {
  const chip = (items: string[], kind: 'income' | 'expense' | 'inv') =>
    items
      .map(
        (c, i) =>
          `<span class="chip">${esc(c)}<button type="button" class="chip-del" data-cad-del="${kind}" data-i="${i}" title="Remover">×</button></span>`
      )
      .join('');
  getEl('cadIncomeList').innerHTML = state.catalog.incomeCategories.length
    ? chip(state.catalog.incomeCategories, 'income')
    : '<span class="muted small">Nenhuma categoria.</span>';
  getEl('cadExpenseList').innerHTML = state.catalog.expenseCategories.length
    ? chip(state.catalog.expenseCategories, 'expense')
    : '<span class="muted small">Nenhuma categoria.</span>';
  getEl('cadInvTypeList').innerHTML = state.catalog.investmentTypes.length
    ? chip(state.catalog.investmentTypes, 'inv')
    : '<span class="muted small">Nenhum tipo.</span>';
  renderBudgetList();
}

function currentMonthExpenseByCategory(): Record<string, number> {
  const { start, end } = currentMonthRange();
  const out: Record<string, number> = {};
  for (const t of state.transactions) {
    if (t.type !== 'saida') continue;
    const d = txnDueKey(t);
    if (d < start || d > end) continue;
    const cat = (t.category || 'Sem categoria').trim() || 'Sem categoria';
    out[cat] = (out[cat] ?? 0) + Number(t.amount ?? 0);
  }
  return out;
}

function budgetUsageRows(): { category: string; limit: number; used: number; pct: number }[] {
  const used = currentMonthExpenseByCategory();
  return Object.entries(state.monthlyBudgets)
    .filter(([, limit]) => limit > 0)
    .map(([category, limit]) => ({
      category,
      limit,
      used: used[category] ?? 0,
      pct: limit > 0 ? ((used[category] ?? 0) / limit) * 100 : 0,
    }))
    .sort((a, b) => b.pct - a.pct);
}

function renderBudgetList(): void {
  const box = document.getElementById('budgetList');
  if (!box) return;
  const used = currentMonthExpenseByCategory();
  const cats = [...state.catalog.expenseCategories];
  const budgetOnly = Object.keys(state.monthlyBudgets).filter((cat) => !cats.includes(cat));
  const rows = [...cats, ...budgetOnly].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  if (!rows.length) {
    box.innerHTML = '<div class="empty">Cadastre categorias de despesa para definir limites mensais.</div>';
    return;
  }
  box.innerHTML = rows
    .map((cat, idx) => {
      const limit = state.monthlyBudgets[cat] ?? 0;
      const spent = used[cat] ?? 0;
      const pct = limit > 0 ? Math.min(999, (spent / limit) * 100) : 0;
      const status =
        limit <= 0 ? 'Sem limite' : pct >= 100 ? 'Estourado' : pct >= 80 ? 'Em risco' : 'Dentro do limite';
      const statusClass = limit <= 0 ? 'muted' : pct >= 80 ? 'negative' : 'positive';
      return `<div class="budget-row"><div class="budget-row-main"><strong>${esc(cat)}</strong><span class="${statusClass}">${esc(status)} - ${brl(spent)} usado${limit > 0 ? ` de ${brl(limit)}` : ''}</span><div class="bar budget-bar"><span style="width:${Math.min(100, pct)}%"></span></div></div><div class="budget-row-input"><label for="budget-${idx}">Limite mensal</label><input id="budget-${idx}" data-budget-category="${esc(cat)}" type="text" inputmode="decimal" placeholder="0,00" value="${limit > 0 ? esc(formatMoneyInputBR(limit)) : ''}" /></div></div>`;
    })
    .join('');
}

function removeCatalogItem(kind: 'income' | 'expense' | 'inv', index: number): void {
  const arr =
    kind === 'income'
      ? state.catalog.incomeCategories
      : kind === 'expense'
        ? state.catalog.expenseCategories
        : state.catalog.investmentTypes;
  if (index >= 0 && index < arr.length) {
    arr.splice(index, 1);
    renderAll();
    toast('Item removido.', 'success');
  }
}

function addCatalogIncome(): void {
  const v = getEl<HTMLInputElement>('cadIncomeInput').value.trim();
  if (!v) return;
  if (state.catalog.incomeCategories.includes(v)) {
    toast('Categoria já existe.', 'error');
    return;
  }
  state.catalog.incomeCategories.push(v);
  state.catalog.incomeCategories.sort((a, b) => a.localeCompare(b, 'pt-BR'));
  getEl<HTMLInputElement>('cadIncomeInput').value = '';
  renderAll();
  toast('Categoria adicionada.', 'success');
}

function addCatalogExpense(): void {
  const v = getEl<HTMLInputElement>('cadExpenseInput').value.trim();
  if (!v) return;
  if (state.catalog.expenseCategories.includes(v)) {
    toast('Categoria já existe.', 'error');
    return;
  }
  state.catalog.expenseCategories.push(v);
  state.catalog.expenseCategories.sort((a, b) => a.localeCompare(b, 'pt-BR'));
  getEl<HTMLInputElement>('cadExpenseInput').value = '';
  renderAll();
  toast('Categoria adicionada.', 'success');
}

function persistBudgetFromInput(input: HTMLInputElement): void {
  const category = input.dataset.budgetCategory;
  if (!category) return;
  const amount = moneyAmountFromUserInput(input.value);
  if (amount > 0) {
    state.monthlyBudgets[category] = amount;
    input.value = formatMoneyInputBR(amount);
  } else {
    delete state.monthlyBudgets[category];
    input.value = '';
  }
  renderAll();
}

function addCatalogInvType(): void {
  const v = getEl<HTMLInputElement>('cadInvTypeInput').value.trim();
  if (!v) return;
  if (state.catalog.investmentTypes.includes(v)) {
    toast('Tipo já existe.', 'error');
    return;
  }
  state.catalog.investmentTypes.push(v);
  state.catalog.investmentTypes.sort((a, b) => a.localeCompare(b, 'pt-BR'));
  getEl<HTMLInputElement>('cadInvTypeInput').value = '';
  renderAll();
  toast('Tipo adicionado.', 'success');
}

function populateInvBankSelect(): void {
  const sel = document.getElementById('invBank') as HTMLSelectElement | null;
  if (!sel) return;
  const head = '<option value="">— Sem vínculo</option>';
  sel.innerHTML = state.banks.length
    ? head + state.banks.map((b) => `<option value="${esc(b.id)}">${esc(bankOptionLabel(b))}</option>`).join('')
    : head;
}

function sumInvestmentsForSavingsGoal(goalId: SavingsGoalId): number {
  return state.investments.reduce(
    (s, inv) => s + (inv.savingsGoalId === goalId ? Number(inv.amount ?? 0) : 0),
    0
  );
}

function totalSavedForGoal(id: SavingsGoalId): number {
  return state.savingsGoals[id].saved + sumInvestmentsForSavingsGoal(id);
}

function updateSavingsGoalVisual(id: SavingsGoalId): void {
  const { target } = state.savingsGoals[id];
  const total = totalSavedForGoal(id);
  const pct = target > 0 ? Math.min(100, (total / target) * 100) : 0;
  const bar = document.querySelector(`[data-goal-bar="${id}"] span`) as HTMLElement | null;
  const pctEl = document.getElementById(`inv-goal-pct-${id}`);
  if (bar) bar.style.width = `${Math.max(pct, target > 0 ? 2 : 0)}%`;
  if (pctEl) {
    pctEl.textContent =
      target > 0
        ? `${total >= target ? 'Meta atingida' : `${brl(target - total)} para a meta`} · ${Math.round(pct)}%`
        : 'Defina a meta em R$';
  }
}

function syncInvestmentsDashboard(): void {
  const year = new Date().getFullYear();
  const ytd = investmentsYearTotal(year);
  const invGoal = Number(state.annualInvestmentGoal ?? 0);

  getEl('invDashYear').textContent = String(year);
  getEl('invDashNetWorth').textContent = brl(totalConsolidatedPatrimony());
  getEl('invDashInvestedTotal').textContent = brl(totalInvestedPatrimony());
  getEl('invDashYtd').textContent = brl(ytd);

  const gapEl = getEl('invDashInvGoalGap');
  if (!invGoal || invGoal <= 0) {
    gapEl.textContent = 'Defina a meta de aportes do ano para ver quanto falta.';
    gapEl.className = 'inv-dash-gap muted';
  } else {
    const short = invGoal - ytd;
    if (short > 0) {
      gapEl.textContent = `Faltam ${brl(short)} para a meta de aportes (${brl(invGoal)} no ano).`;
      gapEl.className = 'inv-dash-gap inv-dash-gap-short';
    } else {
      gapEl.textContent = `Meta de aportes atingida. Acima da meta em ${brl(-short)}.`;
      gapEl.className = 'inv-dash-gap inv-dash-gap-ok';
    }
  }

  const goalInp = getEl<HTMLInputElement>('annualInvestmentGoalInput');
  const goalsHost = getEl('invSavingsGoals');
  const typingGoals = goalsHost.contains(document.activeElement);
  if (document.activeElement !== goalInp) {
    goalInp.value = invGoal > 0 ? formatMoneyInputBR(invGoal) : '';
  }

  if (!typingGoals) {
    for (const id of SAVINGS_GOAL_IDS) {
      const g = state.savingsGoals[id];
      const tIn = goalsHost.querySelector(
        `[data-goal-id="${id}"][data-goal-field="target"]`
      ) as HTMLInputElement | null;
      const sIn = goalsHost.querySelector(
        `[data-goal-id="${id}"][data-goal-field="saved"]`
      ) as HTMLInputElement | null;
      if (tIn) tIn.value = g.target > 0 ? formatMoneyInputBR(g.target) : '';
      if (sIn) sIn.value = g.saved > 0 ? formatMoneyInputBR(g.saved) : '';
    }
  }
  for (const id of SAVINGS_GOAL_IDS) {
    updateSavingsGoalVisual(id);
    const hint = document.getElementById(`inv-goal-aportes-${id}`);
    if (hint) {
      const aport = sumInvestmentsForSavingsGoal(id);
      hint.textContent =
        aport > 0 ? `Inclui ${brl(aport)} de aportes com esta meta nos investimentos.` : '';
    }
  }

  const byBank = getEl('invByBank');
  const rows = investmentsTotalsPerBank();
  if (!rows.length) {
    byBank.innerHTML = '<div class="empty">Nenhum aporte registrado ainda.</div>';
  } else {
    const max = Math.max(...rows.map((r) => r.total), 1);
    byBank.innerHTML = rows
      .map(
        (r) =>
          `<div class="inv-bank-row"><div class="inv-bank-row-head"><strong>${esc(r.name)}</strong><span class="positive">${brl(r.total)}</span></div><div class="bar inv-bank-bar"><span style="width:${Math.max((r.total / max) * 100, r.total > 0 ? 4 : 0)}%"></span></div><div class="muted small">${r.count} aporte(s)</div></div>`
      )
      .join('');
  }
}

function persistAnnualInvestmentGoalFromInput(): void {
  const raw = getEl<HTMLInputElement>('annualInvestmentGoalInput').value;
  state.annualInvestmentGoal = moneyAmountFromUserInput(raw);
  saveState();
  syncInvestmentsDashboard();
  renderPatrimonyGoalStrip();
}

function persistSavingsGoalFromInput(el: HTMLInputElement): void {
  const gid = el.getAttribute('data-goal-id') as SavingsGoalId | null;
  const field = el.getAttribute('data-goal-field') as 'target' | 'saved' | null;
  if (!gid || !field || !(SAVINGS_GOAL_IDS as readonly string[]).includes(gid)) return;
  const v = moneyAmountFromUserInput(el.value);
  state.savingsGoals[gid][field] = v;
  saveState();
  el.value = v > 0 ? formatMoneyInputBR(v) : '';
  updateSavingsGoalVisual(gid);
}

function renderInvestmentsTable(): void {
  syncInvestmentsDashboard();

  const container = getEl('investmentsTable');
  const rows = [...state.investments].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  if (!rows.length) {
    container.innerHTML = '<div class="empty">Nenhum investimento na lista. Use “Novo investimento” ou o lançamento tipo Investimento.</div>';
    return;
  }
  const bankLabel = (inv: Investment) => {
    const bid = resolveInvestmentBankId(inv);
    return bid ? bankLabelById(bid) : '—';
  };
  const metaLabel = (inv: Investment) => savingsGoalDisplayName(inv.savingsGoalId);
  container.innerHTML =
    '<table><thead><tr><th>Data</th><th>Conta</th><th>Meta</th><th>Tipo</th><th>Instituição</th><th>Valor</th><th>% a.m.</th><th>Meses</th><th>Obs.</th><th>Ações</th></tr></thead><tbody>' +
    rows
      .map(
        (inv) =>
          `<tr><td>${dateBR(inv.date)}</td><td>${esc(bankLabel(inv))}</td><td>${esc(metaLabel(inv))}</td><td>${esc(inv.type)}</td><td>${esc(inv.institution)}</td><td>${brl(inv.amount)}</td><td>${inv.monthlyYieldPct != null ? esc(String(inv.monthlyYieldPct)) : '—'}</td><td>${inv.months != null ? esc(String(inv.months)) : '—'}</td><td>${esc(inv.notes ?? '—')}</td><td><div class="row-actions"><button type="button" class="btn ghost" data-edit-inv="${esc(inv.id)}">Editar</button><button type="button" class="btn danger" data-delete-inv="${esc(inv.id)}">Excluir</button></div></td></tr>`
      )
      .join('') +
    '</tbody></table>';
}

function openInvModal(id: string | null): void {
  refreshInvTypeDatalist();
  populateInvBankSelect();
  const modal = getEl('invModal');
  modal.classList.add('open');
  const title = getEl('invModalTitle');
  const delBtn = getEl<HTMLButtonElement>('deleteInvInModal');
  getEl<HTMLInputElement>('invId').value = '';
  getEl<HTMLInputElement>('invDate').value = new Date().toISOString().slice(0, 10);
  getEl<HTMLInputElement>('invType').value = '';
  getEl<HTMLInputElement>('invInstitution').value = '';
  getEl<HTMLInputElement>('invAmount').value = '';
  getEl<HTMLInputElement>('invYieldPct').value = '';
  getEl<HTMLInputElement>('invMonths').value = '';
  getEl<HTMLInputElement>('invNotes').value = '';
  getEl<HTMLSelectElement>('invBank').value = state.banks[0]?.id ?? '';
  getEl<HTMLSelectElement>('invSavingsGoal').value = '';

  if (id) {
    const inv = state.investments.find((x) => x.id === id);
    if (!inv) return;
    title.textContent = 'Editar investimento';
    delBtn.classList.remove('hidden');
    getEl<HTMLInputElement>('invId').value = inv.id;
    const bid = resolveInvestmentBankId(inv);
    getEl<HTMLSelectElement>('invBank').value = bid || '';
    getEl<HTMLInputElement>('invDate').value = inv.date;
    getEl<HTMLInputElement>('invType').value = inv.type;
    getEl<HTMLInputElement>('invInstitution').value = inv.institution;
    getEl<HTMLInputElement>('invAmount').value = formatMoneyInputBR(Number(inv.amount));
    getEl<HTMLInputElement>('invYieldPct').value = inv.monthlyYieldPct != null ? String(inv.monthlyYieldPct) : '';
    getEl<HTMLInputElement>('invMonths').value = inv.months != null ? String(inv.months) : '';
    getEl<HTMLInputElement>('invNotes').value = inv.notes ?? '';
    getEl<HTMLSelectElement>('invSavingsGoal').value =
      inv.savingsGoalId && isSavingsGoalId(inv.savingsGoalId) ? inv.savingsGoalId : '';
    const toDel = id;
    delBtn.onclick = () => {
      deleteInvestment(toDel);
      closeInvModal();
    };
  } else {
    title.textContent = 'Novo investimento';
    delBtn.classList.add('hidden');
    delBtn.onclick = null;
  }
  getEl<HTMLInputElement>('invAmount').focus();
}

function closeInvModal(): void {
  getEl('invModal').classList.remove('open');
}

function saveInvestment(): void {
  const id = getEl<HTMLInputElement>('invId').value.trim();
  const date = getEl<HTMLInputElement>('invDate').value;
  const type = getEl<HTMLInputElement>('invType').value.trim();
  const bankSel = getEl<HTMLSelectElement>('invBank').value;
  const bank = state.banks.find((b) => b.id === bankSel);
  let institution = getEl<HTMLInputElement>('invInstitution').value.trim();
  if (bank && !institution) institution = bank.name.trim();
  const amount = parseMoneyBRL(getEl<HTMLInputElement>('invAmount').value);
  const yRaw = getEl<HTMLInputElement>('invYieldPct').value.trim();
  const mRaw = getEl<HTMLInputElement>('invMonths').value.trim();
  const notes = getEl<HTMLInputElement>('invNotes').value.trim();
  const invGoalRaw = getEl<HTMLSelectElement>('invSavingsGoal').value;
  if (!date || !type || !institution || !Number.isFinite(amount) || amount <= 0) {
    toast('Preencha data, tipo, instituição e um valor válido (ex.: 10.000,00).', 'error');
    return;
  }
  const monthlyYieldPct = yRaw === '' ? undefined : Number(yRaw.replace(',', '.'));
  const months = mRaw === '' ? undefined : Number(mRaw.replace(',', '.'));
  const payload: Investment = {
    id: id || uid(),
    date,
    type,
    institution,
    amount,
    ...(bankSel && state.banks.some((b) => b.id === bankSel) ? { bankId: bankSel } : {}),
    ...(isSavingsGoalId(invGoalRaw) ? { savingsGoalId: invGoalRaw } : {}),
    ...(monthlyYieldPct != null && !Number.isNaN(monthlyYieldPct) ? { monthlyYieldPct } : {}),
    ...(months != null && !Number.isNaN(months) ? { months } : {}),
    ...(notes ? { notes } : {}),
  };
  if (id) {
    const idx = state.investments.findIndex((x) => x.id === id);
    state.investments[idx] = payload;
  } else {
    state.investments.push(payload);
  }
  renderAll();
  closeInvModal();
  switchView('investments');
  toast(id ? 'Investimento atualizado.' : 'Investimento registrado.', 'success');
}

function deleteInvestment(id: string): void {
  if (!confirm('Excluir este registro de investimento?')) return;
  state.investments = state.investments.filter((x) => x.id !== id);
  renderAll();
  toast('Investimento removido.', 'success');
}

function populateBankSelects(): void {
  const head = '<option value="">— Selecione a conta —</option>';
  getEl<HTMLSelectElement>('txnBank').innerHTML = state.banks.length
    ? head + state.banks.map((b) => `<option value="${esc(b.id)}">${esc(bankOptionLabel(b))}</option>`).join('')
    : head;
}

function renderCatalogList(): void {
  const box = document.getElementById('catalogList');
  const input = document.getElementById('catalogSearch') as HTMLInputElement | null;
  if (!box || !input) return;
  const q = input.value.trim().toLowerCase();
  const items = BANK_CATALOG.filter((b) => !q || b.name.toLowerCase().includes(q) || b.code.includes(q)).slice(0, 50);
  if (!items.length) {
    box.innerHTML = '<div class="empty">Nenhum resultado no catálogo.</div>';
    return;
  }
  box.innerHTML = items
    .map(
      (b) =>
        `<div class="bank-item catalog-item" role="option" tabindex="0" data-cat-code="${esc(b.code)}" data-cat-name="${esc(b.name)}" data-cat-seg="${esc(b.segment)}"><div><strong>${esc(b.name)}</strong><br><span class="muted small">Código ${esc(b.code)} · ${esc(b.segment)}</span></div></div>`
    )
    .join('');
}

function renderAll(): void {
  saveState();
  populateBankSelects();
  populateInvBankSelect();
  renderKPIs();
  renderDashboardRecent();
  renderBankBars();
  renderTransactionsTable();
  renderBanksList();
  renderReports();
  renderCatalogList();
  renderCadastrosLists();
  renderInvestmentsTable();
  refreshInvTypeDatalist();
  syncAuthSettingsVisibility();
}

const VIEW_META: Record<ViewId, [string, string]> = {
  dashboard: ['Dashboard', 'Cockpit financeiro com indicadores, alertas e posicao consolidada.'],
  transactions: ['Fluxo de Caixa', 'Operacao diaria: entradas, saidas, vencimentos, importacao e recorrencias.'],
  budgets: ['Orcamentos', 'Limites mensais por categoria, risco de estouro e alertas no dashboard.'],
  banks: ['Contas', 'Instituicoes, tipos de conta e posicao consolidada por banco.'],
  cadastros: ['Parametros', 'Categorias, tipos de investimento e listas de apoio para padronizar registros.'],
  investments: ['Metas e Aportes', 'Aportes, metas, posicao por conta e evolucao do patrimonio.'],
  reports: ['Relatorios', 'Analise por banco, categoria, mes e ano.'],
  settings: ['Dados e Seguranca', 'Backup, protecao local por senha e exportacao dos dados.'],
};

function switchView(view: ViewId): void {
  document.querySelectorAll('[id^="view-"]').forEach((el) => el.classList.add('hidden'));
  getEl(`view-${view}`).classList.remove('hidden');
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    const b = btn as HTMLButtonElement;
    const on = b.dataset.view === view;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  const [title, sub] = VIEW_META[view];
  getEl('pageTitle').textContent = title;
  getEl('pageSubtitle').textContent = sub;
  if (view === 'budgets') renderBudgetList();
  if (view === 'reports') renderReports();
}

function applySidebarPreference(collapsed: boolean): void {
  const appRoot = document.querySelector('.app') as HTMLElement | null;
  const toggle = document.getElementById('sidebarToggle') as HTMLButtonElement | null;
  if (!appRoot || !toggle) return;
  appRoot.classList.toggle('sidebar-collapsed', collapsed);
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.setAttribute('aria-label', collapsed ? 'Expandir menu' : 'Recolher menu');
  toggle.title = collapsed ? 'Expandir menu' : 'Recolher menu';
}

function initSidebarPreference(): void {
  const toggle = document.getElementById('sidebarToggle') as HTMLButtonElement | null;
  const initial = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  applySidebarPreference(initial);
  if (!toggle) return;
  toggle.addEventListener('click', () => {
    const appRoot = document.querySelector('.app') as HTMLElement | null;
    const next = !(appRoot?.classList.contains('sidebar-collapsed') ?? false);
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0');
    applySidebarPreference(next);
  });
}

function openTxnModal(id: string | null): void {
  const modal = getEl('txnModal');
  modal.classList.add('open');
  const title = getEl('txnModalTitle');
  const delBtn = getEl<HTMLButtonElement>('deleteTxnInModal');
  const typeSel = getEl<HTMLSelectElement>('txnType');
  getEl<HTMLInputElement>('txnId').value = '';
  typeSel.innerHTML = txnModalTypeOptionsHtml(!id);
  typeSel.value = 'entrada';
  getEl<HTMLInputElement>('txnAmount').value = '';
  getEl<HTMLInputElement>('txnDate').value = new Date().toISOString().slice(0, 10);
  getEl<HTMLInputElement>('txnCategory').value = '';
  getEl<HTMLInputElement>('txnMethod').value = '';
  getEl<HTMLTextAreaElement>('txnDescription').value = '';
  getEl<HTMLInputElement>('txnDueDate').value = '';
  getEl<HTMLSelectElement>('txnExpenseKind').value = '';
  getEl<HTMLInputElement>('txnUnifiedInvType').value = '';
  getEl<HTMLInputElement>('txnUnifiedInvYield').value = '';
  getEl<HTMLInputElement>('txnUnifiedInvMonths').value = '';
  getEl<HTMLSelectElement>('txnUnifiedInvGoal').value = '';
  getEl<HTMLSelectElement>('txnBank').value = '';

  if (id) {
    const t = state.transactions.find((x) => x.id === id);
    if (!t) return;
    title.textContent = 'Editar lançamento';
    delBtn.classList.remove('hidden');
    getEl<HTMLInputElement>('txnId').value = t.id;
    getEl<HTMLSelectElement>('txnBank').value =
      t.bankId && state.banks.some((b) => b.id === t.bankId) ? t.bankId : '';
    typeSel.value = t.type;
    getEl<HTMLInputElement>('txnAmount').value = formatMoneyInputBR(Number(t.amount));
    getEl<HTMLInputElement>('txnDate').value = t.date;
    getEl<HTMLInputElement>('txnDueDate').value = t.dueDate ?? '';
    getEl<HTMLInputElement>('txnCategory').value = t.category ?? '';
    getEl<HTMLInputElement>('txnMethod').value = t.method ?? '';
    getEl<HTMLTextAreaElement>('txnDescription').value = t.description ?? '';
    syncTxnFormUI(t.status);
    if (t.type === 'saida' && t.expenseKind && isExpenseKind(t.expenseKind)) {
      getEl<HTMLSelectElement>('txnExpenseKind').value = t.expenseKind;
    }
    const toDelete = id;
    delBtn.onclick = () => {
      deleteTransaction(toDelete);
      closeTxnModal();
    };
  } else {
    title.textContent = 'Novo lançamento';
    delBtn.classList.add('hidden');
    delBtn.onclick = null;
    syncTxnFormUI();
    const dateEl = getEl<HTMLInputElement>('txnDate');
    const dueEl = getEl<HTMLInputElement>('txnDueDate');
    if (dateEl.value && !dueEl.value && getTxnModalMode() !== 'investimento') {
      dueEl.value = dateEl.value;
    }
  }
  refreshTxnCategoryDatalist();
  refreshInvTypeDatalist();
  getEl<HTMLInputElement>('txnAmount').focus();
}

function closeTxnModal(): void {
  getEl('txnModal').classList.remove('open');
}

function saveUnifiedInvestment(): void {
  const bankId = getEl<HTMLSelectElement>('txnBank').value;
  const bank = state.banks.find((b) => b.id === bankId);
  const institution = bank?.name?.trim() ?? '';
  const date = getEl<HTMLInputElement>('txnDate').value;
  const amount = parseMoneyBRL(getEl<HTMLInputElement>('txnAmount').value);
  const invType = getEl<HTMLInputElement>('txnUnifiedInvType').value.trim();
  const yRaw = getEl<HTMLInputElement>('txnUnifiedInvYield').value.trim();
  const mRaw = getEl<HTMLInputElement>('txnUnifiedInvMonths').value.trim();
  const notes = getEl<HTMLTextAreaElement>('txnDescription').value.trim();
  if (!bankId || !date || !invType || !institution || !Number.isFinite(amount) || amount <= 0) {
    toast('Preencha banco, data, tipo de investimento e um valor válido (ex.: 10.000,00).', 'error');
    return;
  }
  const monthlyYieldPct = yRaw === '' ? undefined : Number(yRaw.replace(',', '.'));
  const months = mRaw === '' ? undefined : Number(mRaw.replace(',', '.'));
  const goalRaw = getEl<HTMLSelectElement>('txnUnifiedInvGoal').value;
  const payload: Investment = {
    id: uid(),
    date,
    type: invType,
    institution,
    amount,
    bankId,
    ...(isSavingsGoalId(goalRaw) ? { savingsGoalId: goalRaw } : {}),
    ...(monthlyYieldPct != null && !Number.isNaN(monthlyYieldPct) ? { monthlyYieldPct } : {}),
    ...(months != null && !Number.isNaN(months) ? { months } : {}),
    ...(notes ? { notes } : {}),
  };
  state.investments.push(payload);
  renderAll();
  closeTxnModal();
  switchView('investments');
  toast('Investimento registrado.', 'success');
}

function saveTransaction(): void {
  if (getTxnModalMode() === 'investimento') {
    if (!state.banks.length) {
      toast('Cadastre pelo menos um banco antes de registrar investimentos.', 'error');
      switchView('banks');
      return;
    }
    saveUnifiedInvestment();
    return;
  }
  const id = getEl<HTMLInputElement>('txnId').value.trim();
  const typeRaw = getEl<HTMLSelectElement>('txnType').value;
  const type: TxnType = isTxnType(typeRaw) ? typeRaw : 'entrada';
  if (type === 'saida' && !state.banks.length) {
    toast('Cadastre pelo menos um banco antes de lançar despesas.', 'error');
    switchView('banks');
    return;
  }
  const bankSelect = getEl<HTMLSelectElement>('txnBank').value;
  const bankId = type === 'entrada' && !state.banks.length ? '' : bankSelect;
  const amount = parseMoneyBRL(getEl<HTMLInputElement>('txnAmount').value);
  const date = getEl<HTMLInputElement>('txnDate').value;
  const category = getEl<HTMLInputElement>('txnCategory').value.trim();
  const method = getEl<HTMLInputElement>('txnMethod').value.trim();
  const description = getEl<HTMLTextAreaElement>('txnDescription').value.trim();
  const dueRaw = getEl<HTMLInputElement>('txnDueDate').value.trim();
  let expenseKind: ExpenseKind | undefined;
  if (type === 'saida') {
    const ek = getEl<HTMLSelectElement>('txnExpenseKind').value;
    expenseKind = isExpenseKind(ek) ? ek : undefined;
  }
  const status = parseTxnStatus(type, getEl<HTMLSelectElement>('txnStatus').value);
  if (type === 'saida' && !bankId) {
    toast('Selecione a conta para a despesa.', 'error');
    return;
  }
  if (type === 'entrada' && state.banks.length > 0 && !bankId) {
    toast('Selecione a conta creditada para a receita.', 'error');
    return;
  }
  if (!date || !Number.isFinite(amount) || amount <= 0) {
    toast('Preencha data e um valor válido (ex.: 10.000,00 ou 1500,50).', 'error');
    return;
  }
  if (!dueRaw) {
    toast('Informe a data de vencimento.', 'error');
    return;
  }
  const payload: Transaction = {
    id: id || uid(),
    bankId,
    type,
    amount,
    date,
    category,
    method,
    description,
    dueDate: dueRaw,
    ...(type === 'saida' && expenseKind ? { expenseKind } : {}),
    ...(status ? { status } : {}),
  };
  if (id) {
    const idx = state.transactions.findIndex((t) => t.id === id);
    state.transactions[idx] = payload;
  } else {
    state.transactions.push(payload);
  }
  renderAll();
  closeTxnModal();
  switchView('transactions');
  toast(id ? 'Lançamento atualizado.' : 'Lançamento criado.', 'success');
}

function deleteTransaction(id: string): void {
  if (!confirm('Deseja excluir este lançamento?')) return;
  state.transactions = state.transactions.filter((t) => t.id !== id);
  renderAll();
  toast('Lançamento removido.', 'success');
}

function createBank(): void {
  const name = getEl<HTMLInputElement>('bankName').value.trim();
  const accountType = getEl<HTMLSelectElement>('bankAccountType').value;
  const note = getEl<HTMLInputElement>('bankNote').value.trim().slice(0, 500);
  const code = getEl<HTMLInputElement>('bankCode').value.trim();
  const segment = getEl<HTMLInputElement>('bankSegment').value.trim();
  if (!name) {
    toast('Informe o nome do banco.', 'error');
    return;
  }
  const bank: Bank = {
    id: uid(),
    name,
    accountType,
    note,
    ...(code ? { code } : {}),
    ...(segment ? { segment } : {}),
  };
  state.banks.push(bank);
  getEl<HTMLInputElement>('bankName').value = '';
  getEl<HTMLInputElement>('bankNote').value = '';
  getEl<HTMLInputElement>('bankCode').value = '';
  getEl<HTMLInputElement>('bankSegment').value = '';
  getEl<HTMLInputElement>('catalogSearch').value = '';
  renderAll();
  toast('Banco cadastrado.', 'success');
}

function openBankModal(id: string): void {
  const bank = state.banks.find((b) => b.id === id);
  if (!bank) return;
  getEl('bankModal').classList.add('open');
  getEl<HTMLInputElement>('editBankId').value = bank.id;
  getEl<HTMLInputElement>('editBankName').value = bank.name;
  getEl<HTMLInputElement>('editBankCode').value = bank.code ?? '';
  getEl<HTMLInputElement>('editBankSegment').value = bank.segment ?? '';
  getEl<HTMLSelectElement>('editBankAccountType').value = bank.accountType || 'Conta corrente';
  getEl<HTMLInputElement>('editBankNote').value = bank.note ?? '';
  getEl<HTMLInputElement>('editBankName').focus();
}

function closeBankModal(): void {
  getEl('bankModal').classList.remove('open');
}

function saveBankEdit(): void {
  const id = getEl<HTMLInputElement>('editBankId').value;
  const bank = state.banks.find((b) => b.id === id);
  if (!bank) return;
  const name = getEl<HTMLInputElement>('editBankName').value.trim();
  if (!name) {
    toast('O nome é obrigatório.', 'error');
    return;
  }
  bank.name = name;
  const c = getEl<HTMLInputElement>('editBankCode').value.trim();
  const s = getEl<HTMLInputElement>('editBankSegment').value.trim();
  if (c) bank.code = c;
  else delete bank.code;
  if (s) bank.segment = s;
  else delete bank.segment;
  bank.accountType = getEl<HTMLSelectElement>('editBankAccountType').value;
  bank.note = getEl<HTMLInputElement>('editBankNote').value.trim().slice(0, 500);
  renderAll();
  closeBankModal();
  toast('Banco atualizado.', 'success');
}

function deleteBank(id: string): void {
  const hasTxns = state.transactions.some((t) => t.bankId === id);
  const msg = hasTxns
    ? 'Este banco possui lançamentos. Excluir também todos os lançamentos vinculados?'
    : 'Deseja excluir este banco?';
  if (!confirm(msg)) return;
  state.banks = state.banks.filter((b) => b.id !== id);
  state.transactions = state.transactions.filter((t) => t.bankId !== id);
  renderAll();
  toast('Banco removido.', 'success');
}

function exportJson(): void {
  downloadBlob(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }), 'sculacho-backup.json');
  toast('JSON exportado.', 'success');
}

function exportCsv(): void {
  const header = [
    'Data',
    'Vencimento',
    'Banco',
    'Meta',
    'Tipo',
    'Natureza',
    'Status',
    'Categoria',
    'Descricao',
    'FormaPagamento',
    'Valor',
  ];
  const body = mergedCashRowsSorted().map((r) => {
    if (r.kind === 'txn') {
      const t = r.t;
      return [
        t.date,
        t.dueDate ?? '',
        bankLabelById(t.bankId),
        '',
        typeLabel(t.type),
        t.type === 'saida' ? expenseKindLabel(t.expenseKind) : '',
        statusLabel(t.status),
        t.category ?? '',
        t.description ?? '',
        t.method ?? '',
        String(t.amount).replace('.', ','),
      ];
    }
    const inv = r.inv;
    const bid = resolveInvestmentBankId(inv);
    const desc = (inv.notes ?? '').trim() || inv.institution;
    return [
      inv.date,
      '',
      bankLabelById(bid || undefined),
      savingsGoalDisplayName(inv.savingsGoalId),
      'Investimento',
      '',
      '',
      inv.type,
      desc,
      '',
      String(inv.amount).replace('.', ','),
    ];
  });
  const rows: (string | number)[][] = [header, ...body];
  const csv = rows.map((r) => r.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(';')).join('\n');
  downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), 'lancamentos-financeiros.csv');
  toast('CSV exportado.', 'success');
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function importJsonFile(file: File): void {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const imported = JSON.parse(String(reader.result)) as unknown;
      if (typeof imported !== 'object' || imported === null) throw new Error('inválido');
      const o = imported as Record<string, unknown>;
      if (!Array.isArray(o.banks) || !Array.isArray(o.transactions)) throw new Error('inválido');
      state = normalizeImportedState(o);
      renderAll();
      toast('Backup importado com sucesso.', 'success');
    } catch {
      toast('Não foi possível importar o arquivo.', 'error');
    }
  };
  reader.readAsText(file);
}

function seedExample(): void {
  if (state.banks.length || state.transactions.length) {
    if (!confirm('Isso adicionará dados de exemplo sem apagar os atuais. Continuar?')) return;
  }
  const nb: Bank = {
    id: uid(),
    name: 'Nubank',
    accountType: 'Conta corrente',
    note: 'Conta principal',
    code: '260',
    segment: 'Instituição de pagamento',
  };
  const it: Bank = {
    id: uid(),
    name: 'Itaú Unibanco S.A.',
    accountType: 'Conta corrente',
    note: 'Conta secundária',
    code: '341',
    segment: 'Banco múltiplo',
  };
  state.banks.push(nb, it);
  state.transactions.push(
    {
      id: uid(),
      bankId: nb.id,
      type: 'entrada',
      amount: 5500,
      date: '2026-04-05',
      dueDate: '2026-04-05',
      category: 'Salário',
      method: 'PIX',
      description: 'Recebimento mensal',
      status: 'recebido',
    },
    {
      id: uid(),
      bankId: nb.id,
      type: 'saida',
      amount: 820,
      date: '2026-04-06',
      dueDate: '2026-04-08',
      category: 'Mercado',
      method: 'Cartão',
      description: 'Compras do mês',
      expenseKind: 'variavel',
      status: 'pago',
    },
    {
      id: uid(),
      bankId: it.id,
      type: 'saida',
      amount: 230,
      date: '2026-04-07',
      dueDate: '2026-04-10',
      category: 'Internet',
      method: 'Débito',
      description: 'Provedor',
      expenseKind: 'fixa',
      status: 'pago',
    },
    {
      id: uid(),
      bankId: it.id,
      type: 'entrada',
      amount: 400,
      date: '2026-04-08',
      dueDate: '2026-04-15',
      category: 'Freelance',
      method: 'TED',
      description: 'Projeto extra',
      status: 'a_receber',
    }
  );
  for (const c of ['Mercado', 'Internet']) {
    if (!state.catalog.expenseCategories.includes(c)) state.catalog.expenseCategories.push(c);
  }
  state.catalog.expenseCategories.sort((a, b) => a.localeCompare(b, 'pt-BR'));
  state.investments.push({
    id: uid(),
    date: '2026-04-01',
    type: 'CDB',
    institution: nb.name,
    bankId: nb.id,
    savingsGoalId: 'carro',
    amount: 99.37,
    monthlyYieldPct: 0.7,
    months: 10.2,
    notes: 'Exemplo',
  });
  renderAll();
  toast('Dados de exemplo carregados.', 'success');
}

function loadCatalogIntoBanks(): void {
  let added = 0;
  for (const b of BANK_CATALOG) {
    const exists = state.banks.some((x) => x.code === b.code || x.name === b.name);
    if (!exists) {
      state.banks.push({
        id: uid(),
        name: b.name,
        accountType: 'Conta corrente',
        code: b.code,
        segment: b.segment,
        note: 'Catálogo Brasil',
      });
      added++;
    }
  }
  renderAll();
  switchView('banks');
  toast(`${added} banco(s) adicionados do catálogo.`, 'success');
}

function onCatalogPick(el: Element): void {
  const name = el.getAttribute('data-cat-name');
  const code = el.getAttribute('data-cat-code');
  const seg = el.getAttribute('data-cat-seg');
  getEl<HTMLInputElement>('bankName').value = name ?? '';
  getEl<HTMLInputElement>('bankCode').value = code ?? '';
  getEl<HTMLInputElement>('bankSegment').value = seg ?? '';
  getEl<HTMLInputElement>('bankName').focus();
}

async function waitForPasswordIfNeeded(): Promise<void> {
  const appRoot = document.querySelector('.app') as HTMLElement | null;
  const authShell = document.getElementById('authShell');
  const authForm = document.getElementById('authForm') as HTMLFormElement | null;
  const authPw = document.getElementById('authPassword') as HTMLInputElement | null;
  const authErr = document.getElementById('authError');
  if (!appRoot || !authShell || !authForm || !authPw) return;

  if (hasPasswordProtection() && !getSessionKeyMaterial()) {
    authShell.hidden = false;
    appRoot.classList.add('app-auth-locked');
    authPw.value = '';
    authErr?.classList.add('hidden');
    authPw.focus();
    await new Promise<void>((resolve) => {
      const onSubmit = async (e: Event) => {
        e.preventDefault();
        authErr?.classList.add('hidden');
        const ok = await verifyPasswordAndStoreSession(authPw.value);
        if (!ok) {
          if (authErr) {
            authErr.textContent = 'Senha incorreta.';
            authErr.classList.remove('hidden');
          }
          authPw.value = '';
          authPw.focus();
          return;
        }
        authForm.removeEventListener('submit', onSubmit);
        authShell.hidden = true;
        appRoot.classList.remove('app-auth-locked');
        resolve();
      };
      authForm.addEventListener('submit', onSubmit);
    });
  } else {
    authShell.hidden = true;
    appRoot.classList.remove('app-auth-locked');
  }
}

function syncAuthSettingsVisibility(): void {
  const on = hasPasswordProtection();
  const statusEl = document.getElementById('authProtectStatus');
  const setWrap = document.getElementById('authEnableWrap');
  const rmWrap = document.getElementById('authDisableWrap');
  const logout = document.getElementById('btnAuthLogout');
  if (statusEl) {
    statusEl.textContent = on
      ? 'Ativada: dados cifrados no navegador; em cada aba é pedida a senha até entrar.'
      : 'Desativada: os dados em localStorage podem ser lidos por quem usa este browser.';
  }
  if (setWrap) setWrap.classList.toggle('hidden', on);
  if (rmWrap) rmWrap.classList.toggle('hidden', !on);
  if (logout) (logout as HTMLButtonElement).hidden = !on;
}

async function onEnableAuthProtection(): Promise<void> {
  const i1 = document.getElementById('authNewPw1') as HTMLInputElement | null;
  const i2 = document.getElementById('authNewPw2') as HTMLInputElement | null;
  const p1 = i1?.value ?? '';
  const p2 = i2?.value ?? '';
  if (p1.length < 6) {
    toast('Use uma senha com pelo menos 6 caracteres.', 'error');
    return;
  }
  if (p1 !== p2) {
    toast('As senhas não coincidem.', 'error');
    return;
  }
  try {
    await createAuthAndEncryptFirstTime(p1, JSON.stringify(state));
    if (i1) i1.value = '';
    if (i2) i2.value = '';
    syncAuthSettingsVisibility();
    toast('Proteção por senha ativada. Guarde a senha num local seguro.', 'success');
  } catch {
    toast('Não foi possível ativar a proteção neste browser.', 'error');
  }
}

async function onDisableAuthProtection(): Promise<void> {
  const inp = document.getElementById('authCurrentPw') as HTMLInputElement | null;
  const pw = inp?.value ?? '';
  const r = await removePasswordProtection(pw);
  if (!r.ok) {
    toast(r.reason === 'senha' ? 'Senha incorreta.' : 'Não foi possível remover a proteção.', 'error');
    return;
  }
  state = normalizeImportedState(JSON.parse(r.plainJson) as Record<string, unknown>);
  if (inp) inp.value = '';
  syncAuthSettingsVisibility();
  renderAll();
  toast('Proteção removida. Os dados voltaram a ficar legíveis no armazenamento local.', 'success');
}

export async function initApp(): Promise<void> {
  await waitForPasswordIfNeeded();
  state = await loadStateFromDisk();
  initSidebarPreference();

  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = (btn as HTMLButtonElement).dataset.view;
      if (isViewId(v)) switchView(v);
    });
  });

  getEl<HTMLButtonElement>('btnAddTxnInline').addEventListener('click', () => openTxnModal(null));
  getEl<HTMLButtonElement>('btnCreateBank').addEventListener('click', createBank);
  getEl<HTMLButtonElement>('closeTxnModal').addEventListener('click', closeTxnModal);
  getEl<HTMLButtonElement>('saveTxn').addEventListener('click', saveTransaction);
  getEl<HTMLButtonElement>('closeBankModal').addEventListener('click', closeBankModal);
  getEl<HTMLButtonElement>('saveBankEdit').addEventListener('click', saveBankEdit);
  getEl<HTMLButtonElement>('btnExportJson').addEventListener('click', exportJson);
  getEl<HTMLButtonElement>('btnExportCsv').addEventListener('click', exportCsv);
  getEl<HTMLButtonElement>('btnSeed').addEventListener('click', seedExample);
  getEl<HTMLButtonElement>('btnLoadCatalogTop').addEventListener('click', loadCatalogIntoBanks);
  getEl('cashflowTabs').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-cashflow-filter]') as HTMLButtonElement | null;
    const value = btn?.dataset.cashflowFilter;
    if (
      value === 'all' ||
      value === 'payable' ||
      value === 'receivable' ||
      value === 'overdue' ||
      value === 'investments'
    ) {
      cashflowFilter = value;
      renderTransactionsTable();
    }
  });
  getEl<HTMLButtonElement>('btnImportCsv').addEventListener('click', () => getEl<HTMLInputElement>('importCsvFile').click());
  getEl<HTMLInputElement>('importCsvFile').addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      pendingCsvImport = parseCsvImport(String(reader.result ?? ''));
      if (!pendingCsvImport.length) {
        toast('Nao foi possivel reconhecer data e valor no CSV.', 'error');
      }
      renderCsvImportPreview();
    };
    reader.readAsText(file);
    input.value = '';
  });
  getEl('csvImportPreview').addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('#confirmCsvImport')) confirmCsvImport();
    if (target.closest('#cancelCsvImport')) cancelCsvImport();
  });
  getEl<HTMLInputElement>('importJson').addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) importJsonFile(file);
    input.value = '';
  });
  getEl<HTMLSelectElement>('txnType').addEventListener('change', () => {
    const v = getEl<HTMLSelectElement>('txnType').value;
    if (v === 'investimento') {
      getEl<HTMLInputElement>('txnDueDate').value = '';
    }
    if (v === 'investimento') {
      getEl<HTMLSelectElement>('txnExpenseKind').value = '';
    }
    if (v !== 'investimento') {
      getEl<HTMLSelectElement>('txnUnifiedInvGoal').value = '';
    }
    syncTxnFormUI();
    refreshTxnCategoryDatalist();
  });
  getEl<HTMLInputElement>('catalogSearch').addEventListener('input', renderCatalogList);
  getEl<HTMLSelectElement>('reportMode').addEventListener('change', renderReportAnalysis);
  getEl<HTMLSelectElement>('reportYear').addEventListener('change', renderReportAnalysis);
  getEl<HTMLSelectElement>('reportMonth').addEventListener('change', renderReportAnalysis);
  getEl<HTMLButtonElement>('btnCadIncomeAdd').addEventListener('click', addCatalogIncome);
  getEl<HTMLButtonElement>('btnCadExpenseAdd').addEventListener('click', addCatalogExpense);
  getEl<HTMLButtonElement>('btnCadInvTypeAdd').addEventListener('click', addCatalogInvType);
  getEl<HTMLInputElement>('cadIncomeInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addCatalogIncome();
    }
  });
  getEl<HTMLInputElement>('cadExpenseInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addCatalogExpense();
    }
  });
  getEl('budgetList').addEventListener('change', (e) => {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLInputElement && t.matches('input[data-budget-category]')) persistBudgetFromInput(t);
  });
  getEl('budgetList').addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (e.key === 'Enter' && t instanceof HTMLInputElement && t.matches('input[data-budget-category]')) {
      e.preventDefault();
      persistBudgetFromInput(t);
      t.blur();
    }
  });
  getEl<HTMLInputElement>('cadInvTypeInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addCatalogInvType();
    }
  });
  getEl('view-cadastros').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-cad-del]');
    if (!btn) return;
    const kind = btn.getAttribute('data-cad-del') as 'income' | 'expense' | 'inv' | null;
    const i = Number(btn.getAttribute('data-i'));
    if (kind && !Number.isNaN(i)) removeCatalogItem(kind, i);
  });
  getEl<HTMLButtonElement>('btnAddInvInline').addEventListener('click', () => openInvModal(null));
  getEl<HTMLButtonElement>('closeInvModal').addEventListener('click', closeInvModal);
  getEl<HTMLButtonElement>('saveInv').addEventListener('click', saveInvestment);
  getEl<HTMLInputElement>('annualInvestmentGoalInput').addEventListener('change', persistAnnualInvestmentGoalFromInput);
  getEl('invSavingsGoals').addEventListener('change', (e) => {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLInputElement && t.matches('input[data-goal-id]')) persistSavingsGoalFromInput(t);
  });
  getEl('investmentsTable').addEventListener('click', (e) => {
    const ed = (e.target as HTMLElement).closest('[data-edit-inv]');
    const del = (e.target as HTMLElement).closest('[data-delete-inv]');
    if (ed) {
      const id = ed.getAttribute('data-edit-inv');
      if (id) openInvModal(id);
    }
    if (del) {
      const id = del.getAttribute('data-delete-inv');
      if (id) deleteInvestment(id);
    }
  });

  getEl('catalogList').addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest('.catalog-item');
    if (item) onCatalogPick(item);
  });
  getEl('catalogList').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      const item = (e.target as HTMLElement).closest('.catalog-item');
      if (item) {
        e.preventDefault();
        onCatalogPick(item);
      }
    }
  });

  getEl('transactionsTable').addEventListener('click', (e) => {
    const editTxn = (e.target as HTMLElement).closest('[data-edit-txn]');
    const delTxn = (e.target as HTMLElement).closest('[data-delete-txn]');
    const editInv = (e.target as HTMLElement).closest('[data-edit-inv]');
    const delInv = (e.target as HTMLElement).closest('[data-delete-inv]');
    if (editTxn) {
      const id = editTxn.getAttribute('data-edit-txn');
      if (id) openTxnModal(id);
    }
    if (delTxn) {
      const id = delTxn.getAttribute('data-delete-txn');
      if (id) deleteTransaction(id);
    }
    if (editInv) {
      const id = editInv.getAttribute('data-edit-inv');
      if (id) openInvModal(id);
    }
    if (delInv) {
      const id = delInv.getAttribute('data-delete-inv');
      if (id) deleteInvestment(id);
    }
  });

  getEl('banksList').addEventListener('click', (e) => {
    const edit = (e.target as HTMLElement).closest('[data-edit-bank]');
    const del = (e.target as HTMLElement).closest('[data-delete-bank]');
    if (edit) {
      const id = edit.getAttribute('data-edit-bank');
      if (id) openBankModal(id);
    }
    if (del) {
      const id = del.getAttribute('data-delete-bank');
      if (id) deleteBank(id);
    }
  });

  window.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.id === 'txnModal') closeTxnModal();
    if (t.id === 'bankModal') closeBankModal();
    if (t.id === 'invModal') closeInvModal();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeTxnModal();
      closeBankModal();
      closeInvModal();
    }
  });

  populateBankSelects();
  renderAll();

  const btnAuthEnable = document.getElementById('btnAuthEnable');
  const btnAuthDisable = document.getElementById('btnAuthDisable');
  const btnAuthLogout = document.getElementById('btnAuthLogout');
  if (btnAuthEnable) btnAuthEnable.addEventListener('click', () => void onEnableAuthProtection());
  if (btnAuthDisable) btnAuthDisable.addEventListener('click', () => void onDisableAuthProtection());
  if (btnAuthLogout) {
    btnAuthLogout.addEventListener('click', () => {
      clearSessionAuth();
      location.reload();
    });
  }
  syncAuthSettingsVisibility();
}
