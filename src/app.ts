import { BANK_CATALOG } from './catalog';
import type {
  AppCatalog,
  AppState,
  Bank,
  CreditCard,
  CreditCardPayment,
  CreditCardPurchase,
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
const APP_THEME_KEY = 'sculacho.appTheme';
const DEFAULT_TRANSACTION_METHOD = 'PIX';
const DASHBOARD_PERIOD_KEY = 'sculacho.dashboardPeriod';
const CASHFLOW_PERIOD_KEY = 'sculacho.cashflowPeriod';
const DASHBOARD_MONTH_LABELS = [
  'Janeiro',
  'Fevereiro',
  'Marco',
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

const defaultData: AppState = {
  banks: [],
  transactions: [],
  investments: [],
  creditCards: [],
  creditCardPurchases: [],
  creditCardPayments: [],
  catalog: structuredClone(DEFAULT_CATALOG),
  annualPatrimonyGoal: 0,
  annualInvestmentGoal: 0,
  savingsGoals: structuredClone(EMPTY_SAVINGS_GOALS),
  monthlyBudgets: {},
  behaviorLimits: {},
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

function normalizeDay(raw: unknown, fallback: number): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(31, Math.max(1, Math.round(n)));
}

function normalizeCreditCards(raw: unknown): CreditCard[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): CreditCard | null => {
      if (!item || typeof item !== 'object') return null;
      const o = item as Record<string, unknown>;
      const id = typeof o.id === 'string' && o.id.trim() ? o.id : uid();
      const name = typeof o.name === 'string' ? o.name.trim() : '';
      if (!name) return null;
      const limit = typeof o.limit === 'number' && Number.isFinite(o.limit) && o.limit >= 0 ? o.limit : 0;
      return {
        id,
        name,
        ...(typeof o.bankId === 'string' && o.bankId ? { bankId: o.bankId } : {}),
        brand: typeof o.brand === 'string' && o.brand.trim() ? o.brand.trim() : 'Nao informado',
        limit: Math.round(limit * 100) / 100,
        closingDay: normalizeDay(o.closingDay, 25),
        dueDay: normalizeDay(o.dueDay, 10),
      };
    })
    .filter((x): x is CreditCard => x !== null);
}

function normalizeCreditCardPurchases(raw: unknown): CreditCardPurchase[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): CreditCardPurchase | null => {
      if (!item || typeof item !== 'object') return null;
      const o = item as Record<string, unknown>;
      const cardId = typeof o.cardId === 'string' ? o.cardId : '';
      const date = typeof o.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.date) ? o.date : '';
      const amount = typeof o.amount === 'number' && Number.isFinite(o.amount) && o.amount > 0 ? o.amount : 0;
      if (!cardId || !date || amount <= 0) return null;
      const installmentsRaw = typeof o.installments === 'number' ? o.installments : Number(o.installments);
      const installments = Number.isFinite(installmentsRaw) ? Math.min(120, Math.max(1, Math.round(installmentsRaw))) : 1;
      return {
        id: typeof o.id === 'string' && o.id.trim() ? o.id : uid(),
        cardId,
        date,
        description: typeof o.description === 'string' ? o.description.trim().slice(0, 500) : '',
        category: typeof o.category === 'string' ? o.category.trim() : '',
        amount: Math.round(amount * 100) / 100,
        installments,
      };
    })
    .filter((x): x is CreditCardPurchase => x !== null);
}

function normalizeCreditCardPayments(raw: unknown): CreditCardPayment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): CreditCardPayment | null => {
      if (!item || typeof item !== 'object') return null;
      const o = item as Record<string, unknown>;
      const cardId = typeof o.cardId === 'string' ? o.cardId : '';
      const bankId = typeof o.bankId === 'string' ? o.bankId : '';
      const date = typeof o.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.date) ? o.date : '';
      const invoiceDueDate =
        typeof o.invoiceDueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.invoiceDueDate) ? o.invoiceDueDate : '';
      const amount = typeof o.amount === 'number' && Number.isFinite(o.amount) && o.amount > 0 ? o.amount : 0;
      if (!cardId || !bankId || !date || !invoiceDueDate || amount <= 0) return null;
      return {
        id: typeof o.id === 'string' && o.id.trim() ? o.id : uid(),
        cardId,
        invoiceDueDate,
        bankId,
        date,
        amount: Math.round(amount * 100) / 100,
        transactionId: typeof o.transactionId === 'string' ? o.transactionId : '',
      };
    })
    .filter((x): x is CreditCardPayment => x !== null);
}

function normalizeImportedState(o: Record<string, unknown>): AppState {
  const banks = Array.isArray(o.banks) ? (o.banks as Bank[]) : [];
  const rawTx = Array.isArray(o.transactions) ? (o.transactions as Transaction[]) : [];
  const transactions = rawTx.map((t) => ({
    ...t,
    bankId: typeof t.bankId === 'string' ? t.bankId : '',
    ...(typeof t.expenseCardId === 'string' && t.expenseCardId ? { expenseCardId: t.expenseCardId } : {}),
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
  const behaviorLimits = normalizeBudgetMap(o.behaviorLimits);
  const creditCards = normalizeCreditCards(o.creditCards);
  const creditCardPurchases = normalizeCreditCardPurchases(o.creditCardPurchases).filter((p) =>
    creditCards.some((card) => card.id === p.cardId)
  );
  const creditCardPayments = normalizeCreditCardPayments(o.creditCardPayments).filter(
    (p) => creditCards.some((card) => card.id === p.cardId) && banks.some((bank) => bank.id === p.bankId)
  );
  return {
    banks,
    transactions,
    investments,
    creditCards,
    creditCardPurchases,
    creditCardPayments,
    catalog,
    annualPatrimonyGoal,
    annualInvestmentGoal,
    savingsGoals,
    monthlyBudgets,
    behaviorLimits,
  };
}

function creditCardPurchaseDuplicate(purchase: Omit<CreditCardPurchase, 'id'>): boolean {
  return state.creditCardPurchases.some(
    (p) =>
      p.cardId === purchase.cardId &&
      p.date === purchase.date &&
      Number(p.amount ?? 0) === Number(purchase.amount ?? 0) &&
      (p.category ?? '').trim() === (purchase.category ?? '').trim() &&
      (p.description ?? '').trim() === (purchase.description ?? '').trim() &&
      Number(p.installments ?? 1) === Number(purchase.installments ?? 1)
  );
}

function cardTransactionToPurchase(t: Transaction, cardId: string): Omit<CreditCardPurchase, 'id'> {
  return {
    cardId,
    date: t.date,
    description: (t.description || t.category || 'Compra no cartao').trim().slice(0, 500),
    category: (t.category || 'Cartao de Credito').trim(),
    amount: Math.round(Number(t.amount ?? 0) * 100) / 100,
    installments: 1,
  };
}

function migrateCardTransactionsOutOfCashflow(): void {
  const keep: Transaction[] = [];
  let migrated = 0;
  for (const t of state.transactions) {
    const cardId = t.expenseCardId;
    const canMigrate =
      t.type === 'saida' &&
      t.expenseKind === 'cartao' &&
      !!cardId &&
      state.creditCards.some((card) => card.id === cardId) &&
      !!t.date &&
      Number(t.amount ?? 0) > 0;
    if (!canMigrate || !cardId) {
      keep.push(t);
      continue;
    }
    const purchase = cardTransactionToPurchase(t, cardId);
    if (!creditCardPurchaseDuplicate(purchase)) {
      state.creditCardPurchases.push({ id: uid(), ...purchase });
      migrated += 1;
    }
  }
  if (keep.length !== state.transactions.length) {
    state.transactions = keep;
    if (migrated > 0) toast(`${migrated} compra(s) de cartao migrada(s) para faturas.`, 'success');
  }
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
type AssistantDraft = { tx: Transaction; missing: string[]; confidence: number; source: string };
type AssistantCreditDraft = { purchase: CreditCardPurchase; missing: string[]; confidence: number; source: string };
let assistantDraft: AssistantDraft | null = null;
let assistantCreditDraft: AssistantCreditDraft | null = null;
let behaviorGuardResolver: ((ok: boolean) => void) | null = null;
type AppTheme = 'light' | 'blue-glass';
const dashboardNow = new Date();
let dashboardMonth = dashboardNow.getMonth();
let dashboardYear = dashboardNow.getFullYear();
let cashflowMonth = dashboardNow.getMonth();
let cashflowYear = dashboardNow.getFullYear();

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

function creditCardOptionLabel(card: CreditCard): string {
  return `${card.name} - ${card.brand}`;
}

function creditCardLabelById(id: string | undefined | null): string {
  if (id == null || id === '') return '';
  const card = state.creditCards.find((c) => c.id === id);
  return card ? creditCardOptionLabel(card) : 'Cartao';
}

function expenseKindLabel(kind: ExpenseKind | undefined, cardId?: string): string {
  if (kind === 'fixa') return 'Fixa';
  if (kind === 'variavel') return 'Variavel';
  if (kind === 'cartao') {
    const cardLabel = creditCardLabelById(cardId);
    return cardLabel ? `Cartao - ${cardLabel}` : 'Cartao';
  }
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

function txnStatusOptions(type: TxnType): { value: TxnStatus; label: string }[] {
  return type === 'entrada'
    ? [
        { value: 'recebido', label: 'Recebido' },
        { value: 'a_receber', label: 'A receber' },
        { value: 'em_atraso', label: 'Em atraso' },
      ]
    : [
        { value: 'pago', label: 'Pago' },
        { value: 'a_vencer', label: 'A vencer' },
        { value: 'em_atraso', label: 'Em atraso' },
        { value: 'agendado', label: 'Agendado' },
      ];
}

function txnStatusSelectHtml(t: Transaction): string {
  const current = t.status ?? (t.type === 'entrada' ? 'a_receber' : 'a_vencer');
  const options = txnStatusOptions(t.type)
    .map((opt) => `<option value="${esc(opt.value)}"${opt.value === current ? ' selected' : ''}>${esc(opt.label)}</option>`)
    .join('');
  return `<select class="table-status-select table-status-select--${esc(current)}" data-txn-status="${esc(t.id)}" title="Alterar status">${options}</select>`;
}

function fillTxnExpenseKindSelect(selected = ''): void {
  const sel = getEl<HTMLSelectElement>('txnExpenseKind');
  const cardOptions = state.creditCards
    .map((card) => `<option value="card:${esc(card.id)}">${esc(creditCardOptionLabel(card))}</option>`)
    .join('');
  sel.innerHTML =
    '<option value="">â€”</option>' +
    '<option value="fixa">Fixa</option>' +
    '<option value="variavel">VariÃ¡vel</option>' +
    '<option value="cartao">Cartao</option>' +
    (cardOptions ? `<optgroup label="Cartoes cadastrados">${cardOptions}</optgroup>` : '');
  sel.innerHTML =
    '<option value="">&mdash;</option>' +
    '<option value="fixa">Fixa</option>' +
    '<option value="variavel">Vari&aacute;vel</option>' +
    '<option value="cartao">Cart&atilde;o</option>' +
    (cardOptions ? `<optgroup label="Cart&otilde;es cadastrados">${cardOptions}</optgroup>` : '');
  if (selected && [...sel.options].some((opt) => opt.value === selected)) sel.value = selected;
}

type TxnPaymentSource = { kind: 'bank' | 'card' | 'none'; id: string };

function parseTxnPaymentSource(raw = getEl<HTMLSelectElement>('txnBank').value): TxnPaymentSource {
  if (raw.startsWith('card:')) {
    const id = raw.slice(5);
    return state.creditCards.some((card) => card.id === id) ? { kind: 'card', id } : { kind: 'none', id: '' };
  }
  if (raw.startsWith('bank:')) {
    const id = raw.slice(5);
    return state.banks.some((bank) => bank.id === id) ? { kind: 'bank', id } : { kind: 'none', id: '' };
  }
  return state.banks.some((bank) => bank.id === raw) ? { kind: 'bank', id: raw } : { kind: 'none', id: '' };
}

function fillTxnPaymentSourceSelect(mode: 'entrada' | 'saida' | 'investimento', selected = ''): void {
  const sel = getEl<HTMLSelectElement>('txnBank');
  const selectedSource = parseTxnPaymentSource(selected);
  const head =
    mode === 'saida'
      ? '<option value="">-- Selecione conta ou cartao --</option>'
      : '<option value="">-- Selecione a conta --</option>';
  const banksForMode =
    mode === 'investimento'
      ? [...investmentBankAccounts(), ...operationalBankAccounts()]
      : operationalBankAccounts();
  const bankOptions = banksForMode.map((b) => {
    const value = mode === 'saida' ? `bank:${b.id}` : b.id;
    return `<option value="${esc(value)}">${esc(bankOptionLabel(b))}</option>`;
  });
  if (mode !== 'saida') {
    sel.innerHTML = head + bankOptions.join('');
    if (selectedSource.kind === 'bank') sel.value = selectedSource.id;
    return;
  }
  const cardOptions = state.creditCards.map(
    (card) => `<option value="card:${esc(card.id)}">${esc(creditCardOptionLabel(card))}</option>`
  );
  sel.innerHTML =
    head +
    (bankOptions.length ? `<optgroup label="Contas">${bankOptions.join('')}</optgroup>` : '') +
    (cardOptions.length ? `<optgroup label="Cartoes">${cardOptions.join('')}</optgroup>` : '');
  if (selectedSource.kind === 'bank') sel.value = `bank:${selectedSource.id}`;
  if (selectedSource.kind === 'card') sel.value = `card:${selectedSource.id}`;
}

function updateTxnPaymentSourceUI(): void {
  if (getTxnModalMode() !== 'saida') return;
  const source = parseTxnPaymentSource();
  const dueWrap = getEl('txnDueDateWrap');
  const dueInput = getEl<HTMLInputElement>('txnDueDate');
  const methodInput = getEl<HTMLInputElement>('txnMethod');
  const installmentsWrap = getEl('txnInstallmentsWrap');
  const statusWrap = getEl('txnStatusWrap');
  const sub = getEl('txnModalSubtitle');
  if (source.kind === 'card') {
    dueWrap.classList.add('hidden');
    dueInput.removeAttribute('required');
    installmentsWrap.classList.remove('hidden');
    statusWrap.classList.add('hidden');
    methodInput.value = 'Cartao';
    sub.textContent =
      'Despesas no cartao: escolha o cartao, data da compra, classificacao, valor e parcelas. A compra entra na fatura; o caixa so muda quando a fatura for paga.';
    return;
  }
  dueWrap.classList.remove('hidden');
  dueInput.setAttribute('required', 'required');
  installmentsWrap.classList.add('hidden');
  statusWrap.classList.remove('hidden');
  methodInput.value = DEFAULT_TRANSACTION_METHOD;
  sub.textContent =
    'Despesas no PIX: escolha a conta debitada, data de lancamento, data de pagamento, classificacao, valor e status.';
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
  const installmentsWrap = getEl('txnInstallmentsWrap');
  const invWrap = getEl('txnUnifiedInvWrap');
  const bankLbl = getEl('txnBankLabel');
  const sub = getEl('txnModalSubtitle');
  const descLbl = getEl('txnDescriptionLabel');
  const dueLbl = getEl('txnDueDateLabel');
  const methodInput = getEl<HTMLInputElement>('txnMethod');

  if (mode === 'investimento') {
    fillTxnPaymentSourceSelect('investimento', getEl<HTMLSelectElement>('txnBank').value);
    dueWrap.classList.add('hidden');
    getEl<HTMLInputElement>('txnDueDate').removeAttribute('required');
    expenseWrap.classList.add('hidden');
    statusWrap.classList.add('hidden');
    catWrap.classList.add('hidden');
    methodWrap.classList.add('hidden');
    installmentsWrap.classList.add('hidden');
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
  methodWrap.classList.add('hidden');
  installmentsWrap.classList.add('hidden');
  statusWrap.classList.remove('hidden');

  const type = mode;
  dueWrap.classList.remove('hidden');
  getEl<HTMLInputElement>('txnDueDate').setAttribute('required', 'required');
  if (type === 'entrada') {
    fillTxnPaymentSourceSelect('entrada', getEl<HTMLSelectElement>('txnBank').value);
    dueLbl.innerHTML = 'Data de recebimento <span class="req-mark">*</span>';
    methodInput.value = DEFAULT_TRANSACTION_METHOD;
    methodInput.readOnly = true;
    methodInput.placeholder = '';
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
      'Receitas: indique a conta creditada, data de lançamento, classificação, valor e status. A data de recebimento é obrigatória (ex.: quando o crédito cai na conta). Forma de pagamento: PIX.';
    descLbl.textContent = 'Descrição';
  } else {
    dueLbl.innerHTML = 'Data de pagamento <span class="req-mark">*</span>';
    fillTxnPaymentSourceSelect('saida', getEl<HTMLSelectElement>('txnBank').value);
    methodInput.readOnly = true;
    methodInput.placeholder = '';
    getEl('txnBankWrap').classList.remove('hidden');
    bankLbl.textContent = 'Banco / conta debitada ou cartao';
    getEl<HTMLSelectElement>('txnBank').setAttribute('required', 'required');
    expenseWrap.classList.add('hidden');
    fillTxnExpenseKindSelect();
    updateTxnPaymentSourceUI();
    sub.textContent =
      'Despesas: escolha a conta debitada, data de lançamento, data de pagamento, classificação, tipo fixo, variável ou cartão, valor, status e forma de pagamento.';
    updateTxnPaymentSourceUI();
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
  const tipo = normalizedBankAccountType(b);
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
  const tipo = normalizedBankAccountType(b);
  const note = (b.note ?? '').trim();
  if (!note) return `${name} — ${tipo}`;
  return `${name} — ${tipo} · ${note}`;
}

function normalizedBankAccountType(b: Bank): string {
  const raw = (b.accountType ?? '').trim();
  if (/invest/i.test(raw) && /empres/i.test(raw)) return 'Conta investimento empresarial';
  if (/invest/i.test(raw)) return 'Conta investimento';
  return raw || 'Sem tipo';
}

function isInvestmentBankAccount(b: Bank): boolean {
  return normalizedBankAccountType(b).includes('investimento');
}

function operationalBankAccounts(): Bank[] {
  return state.banks.filter((b) => !isInvestmentBankAccount(b));
}

function investmentBankAccounts(): Bank[] {
  return state.banks.filter(isInvestmentBankAccount);
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

function isTxnRealized(t: Transaction): boolean {
  return t.type === 'entrada' ? t.status === 'recebido' : t.status === 'pago';
}

function computeRealizedTotals(txns?: Transaction[]): { income: number; expense: number; balance: number } {
  return computeTotals((txns ?? state.transactions).filter(isTxnRealized));
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
      const { income, expense, balance } = computeRealizedTotals(txns);
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
  const period = dashboardPeriod();
  const total = consolidatedPatrimonyUntil(period.cutoff);
  getEl('kpiTotalPatrimony').textContent = brl(total);
  const year = period.year;
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

function todayIsoLocal(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
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

type DashboardPeriod = {
  year: number;
  month: number;
  start: string;
  end: string;
  cutoff: string;
  isCurrentMonth: boolean;
  isFutureMonth: boolean;
  label: string;
};

type CashflowPeriod = DashboardPeriod;

function isoInLocalMonth(year: number, monthIndex: number, day: number): string {
  const d = new Date(year, monthIndex, day, 12);
  return d.toISOString().slice(0, 10);
}

function periodFromYearMonth(year: number, month: number): DashboardPeriod {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  const start = isoInLocalMonth(year, month, 1);
  const end = isoInLocalMonth(year, month + 1, 0);
  const today = todayIsoLocal();
  const isCurrentMonth = year === currentYear && month === currentMonth;
  const isFutureMonth = year > currentYear || (year === currentYear && month > currentMonth);
  return {
    year,
    month,
    start,
    end,
    cutoff: isCurrentMonth ? today : end,
    isCurrentMonth,
    isFutureMonth,
    label: `${DASHBOARD_MONTH_LABELS[month]} ${year}`,
  };
}

function dashboardPeriod(): DashboardPeriod {
  return periodFromYearMonth(dashboardYear, dashboardMonth);
}

function cashflowPeriod(): CashflowPeriod {
  return periodFromYearMonth(cashflowYear, cashflowMonth);
}

function txnPeriodDate(t: Transaction): string {
  return t.dueDate || t.date || '';
}

function transactionsInPeriod(period = dashboardPeriod()): Transaction[] {
  return state.transactions.filter((t) => {
    const d = txnPeriodDate(t);
    return d >= period.start && d <= period.end;
  });
}

function investmentsInPeriod(period = dashboardPeriod()): Investment[] {
  return state.investments.filter((inv) => (inv.date ?? '') >= period.start && (inv.date ?? '') <= period.end);
}

function totalInvestedUntil(cutoff: string): number {
  return state.investments
    .filter((inv) => (inv.date ?? '') <= cutoff)
    .reduce((s, inv) => s + Number(inv.amount ?? 0), 0);
}

function consolidatedPatrimonyUntil(cutoff: string): number {
  const txns = state.transactions.filter((t) => txnPeriodDate(t) <= cutoff);
  return computeTotals(txns).balance + totalInvestedUntil(cutoff);
}

function loadDashboardPeriodPreference(): void {
  const raw = localStorage.getItem(DASHBOARD_PERIOD_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as { year?: unknown; month?: unknown };
    const y = Number(parsed.year);
    const m = Number(parsed.month);
    if (Number.isInteger(y) && y >= 2000 && y <= 2100) dashboardYear = y;
    if (Number.isInteger(m) && m >= 0 && m <= 11) dashboardMonth = m;
  } catch {
    // Mantem o mes atual quando a preferencia local estiver invalida.
  }
}

function saveDashboardPeriodPreference(): void {
  localStorage.setItem(DASHBOARD_PERIOD_KEY, JSON.stringify({ year: dashboardYear, month: dashboardMonth }));
}

function loadCashflowPeriodPreference(): void {
  const raw = localStorage.getItem(CASHFLOW_PERIOD_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as { year?: unknown; month?: unknown };
    const y = Number(parsed.year);
    const m = Number(parsed.month);
    if (Number.isInteger(y) && y >= 2000 && y <= 2100) cashflowYear = y;
    if (Number.isInteger(m) && m >= 0 && m <= 11) cashflowMonth = m;
  } catch {
    // Mantem o mes atual quando a preferencia local estiver invalida.
  }
}

function saveCashflowPeriodPreference(): void {
  localStorage.setItem(CASHFLOW_PERIOD_KEY, JSON.stringify({ year: cashflowYear, month: cashflowMonth }));
}

function dashboardDecisionItemHtml(kind: 'ok' | 'warn' | 'info', label: string, value: string, detail: string): string {
  const icons: Record<string, string> = {
    'Caixa do mes': '▣',
    'Caixa do mês': '▣',
    'Proximos 7 dias': '◌',
    'Próximos 7 dias': '◌',
    'Compromissos do periodo': '◌',
    'Projecao do mes': '▤',
    'Projeção do mês': '▤',
    'Aporte do mes': '%',
    'Aporte do mês': '%',
    'Patrimonio ate corte': '◎',
    'Patrimônio até corte': '◎',
    Orcamento: '!',
  };
  const icon = icons[label] ?? '✓';
  return `<article class="decision-item decision-item--${kind}"><div class="decision-item-head"><span class="decision-icon">${esc(icon)}</span><span class="decision-label">${esc(label)}</span></div><strong>${esc(value)}</strong><p>${esc(detail)}</p><span class="decision-check">✓</span></article>`;
}

type BehaviorSignal = {
  kind: 'ok' | 'warn' | 'info';
  title: string;
  metric: string;
  detail: string;
  advice: string;
};

type BehaviorSpend = {
  date: string;
  amount: number;
  label: string;
  source: 'fluxo' | 'cartao';
};

const SENSITIVE_BEHAVIOR_RULES = [
  {
    key: 'apostas',
    label: 'Apostas e jogos',
    terms: ['aposta', 'apostas', 'bet', 'bets', 'cassino', 'casino', 'jogo online', 'tigrinho', 'blaze', 'bet365', 'pixbet'],
    advice: 'Se isso apareceu de novo, vale definir um limite zero ou um teto semanal e pausar novos depósitos por 24 horas.',
  },
  {
    key: 'impulso',
    label: 'Compras por impulso',
    terms: ['impulso', 'shopping', 'loja', 'amazon', 'mercado livre', 'shein', 'shopee', 'aliexpress', 'roupa', 'tenis'],
    advice: 'Antes da proxima compra, deixe no carrinho por 20 minutos e confirme se ela cabe na fatura aberta.',
  },
  {
    key: 'delivery',
    label: 'Delivery e comida pronta',
    terms: ['ifood', 'delivery', 'restaurante', 'lanche', 'pizza', 'hamburguer', 'padaria', 'comida'],
    advice: 'Tente escolher um teto semanal para delivery. Pequenas compras repetidas costumam pesar sem parecer.',
  },
  {
    key: 'assinaturas',
    label: 'Assinaturas e recorrencias',
    terms: ['assinatura', 'netflix', 'spotify', 'prime', 'disney', 'hbo', 'recorrente', 'mensalidade'],
    advice: 'Revise se essa assinatura ainda entrega valor. Cancelar uma recorrencia pequena libera caixa todos os meses.',
  },
  {
    key: 'lazer',
    label: 'Lazer e saidas',
    terms: ['bar', 'balada', 'bebida', 'cerveja', 'show', 'cinema', 'lazer'],
    advice: 'Se o lazer subiu, preserve uma verba fixa para curtir sem invadir dinheiro de meta ou fatura.',
  },
];

function behaviorItemHtml(signal: BehaviorSignal): string {
  return `<article class="behavior-item behavior-item--${signal.kind}"><span>${esc(signal.title)}</span><strong>${esc(signal.metric)}</strong><p>${esc(signal.detail)}</p><small>${esc(signal.advice)}</small></article>`;
}

function monthBoundsFromOffset(offset: number): { start: string; end: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + offset;
  return {
    start: new Date(y, m, 1, 12).toISOString().slice(0, 10),
    end: new Date(y, m + 1, 0, 12).toISOString().slice(0, 10),
  };
}

function behaviorSpendText(s: BehaviorSpend): string {
  return normalizeAssistantText(s.label);
}

function behaviorSpendRows(): BehaviorSpend[] {
  const txRows: BehaviorSpend[] = state.transactions
    .filter((t) => t.type === 'saida')
    .map((t) => ({
      date: t.date || t.dueDate || '',
      amount: Number(t.amount ?? 0),
      label: `${t.category ?? ''} ${t.description ?? ''} ${t.method ?? ''}`,
      source: 'fluxo',
    }));
  const cardRows: BehaviorSpend[] = state.creditCardPurchases.map((p) => ({
    date: p.date,
    amount: Number(p.amount ?? 0),
    label: `${p.category ?? ''} ${p.description ?? ''}`,
    source: 'cartao',
  }));
  return [...txRows, ...cardRows].filter((r) => r.date && r.amount > 0);
}

function sumBehaviorSpends(rows: BehaviorSpend[], start: string, end: string): number {
  return rows.filter((r) => r.date >= start && r.date <= end).reduce((sum, r) => sum + r.amount, 0);
}

function behaviorHabitRows(): {
  key: string;
  label: string;
  current: number;
  previous: number;
  limit: number;
  pct: number;
  recentCount: number;
  countMonth: number;
  kind: 'ok' | 'warn' | 'info';
  advice: string;
}[] {
  const rows = behaviorSpendRows();
  const today = new Date().toISOString().slice(0, 10);
  const weekStart = addDaysIso(today, -6);
  const currentBounds = monthBoundsFromOffset(0);
  const previousBounds = monthBoundsFromOffset(-1);
  return SENSITIVE_BEHAVIOR_RULES.map((rule) => {
    const matches = rows.filter((r) => rule.terms.some((term) => behaviorSpendText(r).includes(term)));
    const current = sumBehaviorSpends(matches, currentBounds.start, currentBounds.end);
    const previous = sumBehaviorSpends(matches, previousBounds.start, previousBounds.end);
    const recentCount = matches.filter((r) => r.date >= weekStart && r.date <= today).length;
    const countMonth = matches.filter((r) => r.date >= currentBounds.start && r.date <= currentBounds.end).length;
    const growth = previous > 0 ? ((current - previous) / previous) * 100 : 0;
    const limit = state.behaviorLimits[rule.key] ?? 0;
    const pct = limit > 0 ? (current / limit) * 100 : 0;
    const kind: 'ok' | 'warn' | 'info' =
      limit > 0 && pct >= 100
        ? 'warn'
        : rule.key === 'apostas' && current > 0
          ? 'warn'
          : recentCount >= 3 || growth >= 40 || current >= 300 || (limit > 0 && pct >= 80)
            ? 'warn'
            : current > 0
              ? 'info'
              : 'ok';
    return {
      key: rule.key,
      label: rule.label,
      current,
      previous,
      limit,
      pct,
      recentCount,
      countMonth,
      kind,
      advice:
        limit > 0 && pct >= 100
          ? 'O limite combinado foi estourado. Pause novas compras nesse habito e revise o que disparou esse comportamento.'
          : current > 0
            ? rule.advice
            : 'Sem sinal relevante agora. Continue registrando para melhorar a leitura.',
    };
  });
}

function renderBehaviorView(): void {
  const list = document.getElementById('behaviorHabitList');
  if (!list) return;
  const rows = behaviorHabitRows();
  const sensitiveTotal = rows.reduce((sum, row) => sum + row.current, 0);
  const riskCount = rows.filter((row) => row.kind === 'warn').length;
  const recentCount = rows.reduce((sum, row) => sum + row.recentCount, 0);
  getEl('behaviorSensitiveTotal').textContent = brl(sensitiveTotal);
  getEl('behaviorRiskCount').textContent = String(riskCount);
  getEl('behaviorRecentCount').textContent = String(recentCount);
  list.innerHTML = rows
    .map((row) => {
      const delta = row.previous > 0 ? ((row.current - row.previous) / row.previous) * 100 : null;
      const deltaText = delta == null ? 'Sem base anterior' : `${delta >= 0 ? '+' : ''}${Math.round(delta)}% vs mes anterior`;
      const status =
        row.limit > 0 && row.pct >= 100 ? 'Estourado' : row.kind === 'warn' ? 'Atencao' : row.kind === 'info' ? 'Monitorar' : 'Controlado';
      const limitLine = row.limit > 0 ? `${Math.round(row.pct)}% do limite de ${brl(row.limit)}` : 'Defina um limite mensal';
      return `<article class="behavior-habit behavior-habit--${row.kind}"><div><span>${esc(status)}</span><h3>${esc(row.label)}</h3><p>${esc(row.advice)}</p><div class="behavior-limit-field"><label for="behavior-limit-${esc(row.key)}">Limite mensal</label><input id="behavior-limit-${esc(row.key)}" data-behavior-limit="${esc(row.key)}" type="text" inputmode="decimal" placeholder="0,00" value="${row.limit > 0 ? esc(formatMoneyInputBR(row.limit)) : ''}" /></div></div><div class="behavior-habit-metrics"><strong>${brl(row.current)}</strong><small>${esc(limitLine)}</small><small>${esc(deltaText)}</small><small>${row.countMonth} registro(s) no mes - ${row.recentCount} nos ultimos 7 dias</small></div></article>`;
    })
    .join('');
}

function persistBehaviorLimitFromInput(input: HTMLInputElement): void {
  const key = input.dataset.behaviorLimit;
  if (!key) return;
  const amount = moneyAmountFromUserInput(input.value);
  if (amount > 0) {
    state.behaviorLimits[key] = amount;
    input.value = formatMoneyInputBR(amount);
  } else {
    delete state.behaviorLimits[key];
    input.value = '';
  }
  renderAll();
  toast('Limite de habito atualizado.', 'success');
}

function behaviorGuardForSpend(label: string, amount: number, date: string): string | null {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const text = normalizeAssistantText(label);
  const currentBounds = monthBoundsFromOffset(0);
  const rows = behaviorSpendRows();
  for (const rule of SENSITIVE_BEHAVIOR_RULES) {
    if (!rule.terms.some((term) => text.includes(term))) continue;
    const limit = state.behaviorLimits[rule.key] ?? 0;
    const matches = rows.filter((r) => rule.terms.some((term) => behaviorSpendText(r).includes(term)));
    const monthTotal = sumBehaviorSpends(matches, currentBounds.start, currentBounds.end);
    const projected = date >= currentBounds.start && date <= currentBounds.end ? monthTotal + amount : monthTotal;
    const pct = limit > 0 ? (projected / limit) * 100 : 0;
    if (limit > 0 && pct >= 100) {
      return `Pausa rapida: ${rule.label} chegaria a ${brl(projected)}, passando do limite mensal de ${brl(limit)}. Quer registrar mesmo assim?`;
    }
    if (limit > 0 && pct >= 80) {
      return `Pausa rapida: ${rule.label} ficaria em ${Math.round(pct)}% do limite mensal. Quer registrar mesmo assim?`;
    }
    if (rule.key === 'apostas') {
      return `Pausa rapida: esse gasto parece entrar em ${rule.label}. Se for impulso, vale esperar alguns minutos antes de confirmar. Registrar mesmo assim?`;
    }
    const recentStart = addDaysIso(new Date().toISOString().slice(0, 10), -6);
    const recent = matches.filter((r) => r.date >= recentStart).length;
    if (recent >= 2) {
      return `Pausa rapida: ${rule.label} ja apareceu ${recent} vez(es) nos ultimos 7 dias. Quer registrar mais este gasto?`;
    }
  }
  return null;
}

function closeBehaviorGuardModal(ok: boolean): void {
  getEl('behaviorGuardModal').classList.remove('open');
  const resolver = behaviorGuardResolver;
  behaviorGuardResolver = null;
  if (resolver) resolver(ok);
}

function askBehaviorGuard(message: string): Promise<boolean> {
  getEl('behaviorGuardMessage').textContent = message;
  getEl('behaviorGuardModal').classList.add('open');
  getEl<HTMLButtonElement>('behaviorGuardConfirm').focus();
  return new Promise((resolve) => {
    behaviorGuardResolver = resolve;
  });
}

async function confirmBehaviorGuard(label: string, amount: number, date: string): Promise<boolean> {
  const message = behaviorGuardForSpend(label, amount, date);
  return !message || askBehaviorGuard(message);
}

function renderBehaviorPartner(): void {
  const box = document.getElementById('behaviorPartner');
  if (!box) return;
  const rows = behaviorSpendRows();
  if (!rows.length) {
    box.innerHTML =
      '<div class="empty">Registre despesas e compras no cartao para o Sculacho começar a perceber seus padroes.</div>';
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const weekStart = addDaysIso(today, -6);
  const current = monthBoundsFromOffset(0);
  const previous = monthBoundsFromOffset(-1);
  const signals: BehaviorSignal[] = [];

  for (const rule of SENSITIVE_BEHAVIOR_RULES) {
    const matches = rows.filter((r) => rule.terms.some((term) => behaviorSpendText(r).includes(term)));
    if (!matches.length) continue;
    const monthTotal = sumBehaviorSpends(matches, current.start, current.end);
    const prevTotal = sumBehaviorSpends(matches, previous.start, previous.end);
    const recent = matches.filter((r) => r.date >= weekStart && r.date <= today);
    if (recent.length >= 3 || monthTotal >= 300 || rule.key === 'apostas') {
      const growth = prevTotal > 0 ? ((monthTotal - prevTotal) / prevTotal) * 100 : null;
      signals.push({
        kind: rule.key === 'apostas' || recent.length >= 3 || (growth != null && growth >= 40) ? 'warn' : 'info',
        title: rule.label,
        metric: `${brl(monthTotal)} no mes`,
        detail:
          growth != null
            ? `${recent.length} registro(s) nos ultimos 7 dias; variacao de ${Math.round(growth)}% contra o mes anterior.`
            : `${recent.length} registro(s) nos ultimos 7 dias. Ainda nao ha base do mes anterior.`,
        advice: rule.advice,
      });
    }
  }

  const budgetRisk = budgetUsageRows().find((row) => row.pct >= 80)!;
  if (budgetRisk) {
    signals.push({
      kind: budgetRisk.pct >= 100 ? 'warn' : 'info',
      title: 'Orcamento sensivel',
      metric: `${Math.round(budgetRisk.pct)}% usado`,
      detail: `${budgetRisk.category} ja consumiu ${brl(budgetRisk.used)} de ${brl(budgetRisk.limit)} neste mes.`,
      advice: 'Trate esse limite como um acordo consigo mesmo. Ate virar o mes, evite novas compras nessa categoria.',
    });
  }

  const cardLines = typeof creditInvoiceLines === 'function' ? creditInvoiceLines() : [];
  const currentDue = cardLines.length ? currentCreditInvoiceDue(cardLines) : null;
  const avgIncome = averageMonthlyIncome();
  if (currentDue && avgIncome > 0) {
    const open = state.creditCards.reduce((sum, card) => sum + creditInvoiceOpenAmount(card.id, currentDue, cardLines), 0);
    const pressure = (open / avgIncome) * 100;
    if (pressure >= 25) {
      signals.push({
        kind: pressure >= 40 ? 'warn' : 'info',
        title: 'Fatura pressionando renda',
        metric: `${Math.round(pressure)}% da renda media`,
        detail: `A proxima fatura em aberto esta em ${brl(open)} para ${dateBR(currentDue)}.`,
        advice: 'Antes de parcelar de novo, simule a compra no menu Cartoes e veja se a proxima fatura continua confortavel.',
      });
    }
  }

  const smallRecent = rows.filter((r) => r.date >= weekStart && r.date <= today && r.amount <= 80);
  const smallTotal = smallRecent.reduce((sum, r) => sum + r.amount, 0);
  if (smallRecent.length >= 5 && smallTotal >= 150) {
    signals.push({
      kind: 'info',
      title: 'Compras pequenas repetidas',
      metric: `${brl(smallTotal)} em 7 dias`,
      detail: `${smallRecent.length} compras pequenas detectadas. Elas costumam passar despercebidas no dia a dia.`,
      advice: 'Agrupe essas compras em uma categoria e defina um teto semanal para reduzir vazamento de caixa.',
    });
  }

  if (!signals.length) {
    signals.push({
      kind: 'ok',
      title: 'Sem padrao critico agora',
      metric: 'Ritmo controlado',
      detail: 'Nao encontrei repeticao sensivel ou pressao forte com os dados atuais.',
      advice: 'Continue registrando as compras. Quanto mais historico, melhores ficam os alertas.',
    });
  }

  const coachingCards: BehaviorSignal[] = [
    {
      kind: 'info',
      title: 'Regra dos 20 minutos',
      metric: 'Pausa antes da compra',
      detail: 'Quando parecer impulso, espere um pouco antes de pagar.',
      advice: 'Se depois da pausa ainda fizer sentido e couber no limite, registre com tranquilidade.',
    },
    {
      kind: 'info',
      title: 'Limite de protecao',
      metric: 'Teto por habito',
      detail: 'Delivery, apostas e compras online ficam mais leves quando têm um limite mensal visivel.',
      advice: 'Use o menu Comportamento para combinar limites consigo mesmo.',
    },
    {
      kind: 'ok',
      title: 'Meta protegida',
      metric: 'Decisao com proposito',
      detail: 'Antes de parcelar, compare a compra com sua meta principal.',
      advice: 'Se a compra afasta a meta, talvez ela mereca esperar.',
    },
  ];
  for (const card of coachingCards) {
    if (signals.length >= 4) break;
    signals.push(card);
  }

  box.innerHTML = signals.slice(0, 4).map(behaviorItemHtml).join('');
}

function renderSidebarTip(): void {
  const box = document.getElementById('sidebarTip');
  if (!box) return;
  const budgetRisk = budgetUsageRows().find((row) => row.pct >= 80)!;
  if (budgetRisk) {
    box.innerHTML = `<span>Atencao</span><strong>${esc(budgetRisk.category)} em ${Math.round(budgetRisk.pct)}%</strong><p>Segure novas compras nessa categoria ate virar o mes.</p>`;
    return;
  }
  const cardLines = creditInvoiceLines();
  const currentDue = currentCreditInvoiceDue(cardLines);
  if (currentDue) {
    const open = state.creditCards.reduce((sum, card) => sum + creditInvoiceOpenAmount(card.id, currentDue, cardLines), 0);
    if (open > 0) {
      box.innerHTML = `<span>Proxima acao</span><strong>Fatura de ${brl(open)}</strong><p>Vencimento ${dateBR(currentDue)}. Simule novas compras antes de parcelar.</p>`;
      return;
    }
  }
  const sensitiveRows = behaviorSpendRows().filter((row) =>
    SENSITIVE_BEHAVIOR_RULES.some((rule) => rule.terms.some((term) => behaviorSpendText(row).includes(term)))
  );
  if (sensitiveRows.length) {
    const last = [...sensitiveRows].sort((a, b) => b.date.localeCompare(a.date))[0];
    box.innerHTML = `<span>Padrao observado</span><strong>${esc(last.label.slice(0, 34) || 'Gasto sensivel')}</strong><p>Vi um gasto sensivel recente. Vale definir um teto para se proteger.</p>`;
    return;
  }
  const { balance } = computeTotals();
  if (state.transactions.length || state.creditCardPurchases.length) {
    box.innerHTML = `<span>Dica rapida</span><strong>${balance >= 0 ? 'Caixa positivo' : 'Caixa pressionado'}</strong><p>${balance >= 0 ? 'Antes de gastar, veja se cabe na meta ou na fatura.' : 'Revise despesas abertas antes de assumir novos compromissos.'}</p>`;
    return;
  }
  box.innerHTML =
    '<span>Dica rapida</span><strong>Registre o dia em uma frase.</strong><p>Use o Assistente local no Fluxo de Caixa para transformar texto em lancamento.</p>';
}

function renderSidebarEducationTip(): void {
  const box = document.getElementById('sidebarEducationTip');
  if (!box) return;
  const budgetRisk = budgetUsageRows().find((row) => row.pct >= 80);
  if (budgetRisk) {
    box.innerHTML =
      '<span>Inteligencia financeira</span><strong>Limite protege decisao.</strong><p>Quando uma categoria passa de 80%, trate novas compras nela como excecao, nao como rotina.</p>';
    return;
  }
  const cardLines = creditInvoiceLines();
  const currentDue = currentCreditInvoiceDue(cardLines);
  const avgIncome = averageMonthlyIncome();
  if (currentDue && avgIncome > 0) {
    const open = state.creditCards.reduce((sum, card) => sum + creditInvoiceOpenAmount(card.id, currentDue, cardLines), 0);
    const pressure = (open / avgIncome) * 100;
    if (pressure >= 25) {
      box.innerHTML =
        '<span>Inteligencia financeira</span><strong>Fatura tambem e futuro.</strong><p>Evite parcelar quando a proxima fatura ja passa de 25% da sua renda media.</p>';
      return;
    }
  }
  const sensitiveRows = behaviorSpendRows().filter((row) =>
    SENSITIVE_BEHAVIOR_RULES.some((rule) => rule.terms.some((term) => behaviorSpendText(row).includes(term)))
  );
  if (sensitiveRows.length) {
    box.innerHTML =
      '<span>Inteligencia financeira</span><strong>Impulso pede intervalo.</strong><p>Antes de repetir um gasto sensivel, espere 20 minutos e pergunte se isso aproxima ou afasta sua meta.</p>';
    return;
  }
  if (state.investments.length || state.annualInvestmentGoal > 0) {
    box.innerHTML =
      '<span>Inteligencia financeira</span><strong>Meta precisa de ritmo.</strong><p>Uma meta forte combina valor, prazo e aporte minimo. O progresso pequeno consistente vence o improviso.</p>';
    return;
  }
  box.innerHTML =
    '<span>Inteligencia financeira</span><strong>Pequenos vazamentos contam.</strong><p>Compras pequenas repetidas podem pesar mais que uma despesa grande planejada.</p>';
}

function renderDashboardPeriodControls(): void {
  const monthSel = document.getElementById('dashboardMonth') as HTMLSelectElement | null;
  const yearInput = document.getElementById('dashboardYear') as HTMLInputElement | null;
  const title = document.getElementById('dashboardPeriodTitle');
  const hint = document.getElementById('dashboardPeriodHint');
  if (!monthSel || !yearInput || !title || !hint) return;
  if (!monthSel.options.length) {
    monthSel.innerHTML = DASHBOARD_MONTH_LABELS.map((label, i) => `<option value="${i}">${esc(label)}</option>`).join('');
  }
  monthSel.value = String(dashboardMonth);
  yearInput.value = String(dashboardYear);
  const period = dashboardPeriod();
  title.textContent = period.label;
  hint.textContent = period.isFutureMonth
    ? `Visao futura: compromissos e lancamentos previstos de ${dateBR(period.start)} a ${dateBR(period.end)}.`
    : `Retrato ate ${dateBR(period.cutoff)}; receitas e despesas pela data de recebimento/pagamento.`;
}

function renderCashflowPeriodControls(): void {
  const monthSel = document.getElementById('cashflowMonth') as HTMLSelectElement | null;
  const yearInput = document.getElementById('cashflowYear') as HTMLInputElement | null;
  const title = document.getElementById('cashflowPeriodTitle');
  if (!monthSel || !yearInput || !title) return;
  if (!monthSel.options.length) {
    monthSel.innerHTML = DASHBOARD_MONTH_LABELS.map((label, i) => `<option value="${i}">${esc(label)}</option>`).join('');
  }
  monthSel.value = String(cashflowMonth);
  yearInput.value = String(cashflowYear);
  title.textContent = cashflowPeriod().label;
}

function renderDashboardDecisionCenter(): void {
  const container = document.getElementById('dashboardDecisionCenter');
  if (!container) return;
  {
  const period = dashboardPeriod();
  const today = todayIsoLocal();
  const windowStart = period.isCurrentMonth ? today : period.start;
  const windowEnd = period.isCurrentMonth ? addDaysIso(today, 7) : period.end;
  const monthTxnsForPeriod = transactionsInPeriod(period);
  const monthTotalsForPeriod = computeTotals(monthTxnsForPeriod);
  const monthInvestedForPeriod = investmentsInPeriod(period).reduce((s, inv) => s + Number(inv.amount ?? 0), 0);
  const projectedForPeriod = monthTotalsForPeriod.income - monthTotalsForPeriod.expense - monthInvestedForPeriod;
  const pendingForPeriod = state.transactions.filter((t) => {
    if (t.type !== 'saida' || t.status === 'pago') return false;
    const d = txnPeriodDate(t);
    return d >= windowStart && d <= windowEnd;
  });
  const pendingTotalForPeriod = pendingForPeriod.reduce((s, t) => s + Number(t.amount ?? 0), 0);
  const investedUntilCutoff = totalInvestedUntil(period.cutoff);
  const patrimonyUntilCutoff = consolidatedPatrimonyUntil(period.cutoff);
  const investRateForPeriod =
    monthTotalsForPeriod.income > 0 ? (monthInvestedForPeriod / monthTotalsForPeriod.income) * 100 : 0;
  const budgetRiskForPeriod = budgetUsageRows().find((row) => row.pct >= 80);
  const itemsForPeriod = [
    dashboardDecisionItemHtml(
      monthTotalsForPeriod.balance >= 0 ? 'ok' : 'warn',
      'Caixa do mes',
      brl(monthTotalsForPeriod.balance),
      monthTotalsForPeriod.balance >= 0 ? `Entradas superam saidas em ${period.label}.` : `Saidas superam entradas em ${period.label}.`
    ),
    dashboardDecisionItemHtml(
      pendingForPeriod.length ? 'warn' : 'ok',
      period.isCurrentMonth ? 'Proximos 7 dias' : 'Compromissos do periodo',
      pendingForPeriod.length ? brl(pendingTotalForPeriod) : 'Sem alertas',
      pendingForPeriod.length ? `${pendingForPeriod.length} despesa(s) pendente(s) no recorte.` : 'Nenhuma despesa pendente encontrada.'
    ),
    dashboardDecisionItemHtml(
      projectedForPeriod >= 0 ? 'ok' : 'warn',
      'Projecao do mes',
      brl(projectedForPeriod),
      'Receitas menos despesas e aportes com data no mes selecionado.'
    ),
    dashboardDecisionItemHtml(
      investRateForPeriod >= 10 ? 'ok' : 'info',
      'Aporte do mes',
      monthTotalsForPeriod.income > 0 ? `${Math.round(investRateForPeriod)}%` : brl(monthInvestedForPeriod),
      monthTotalsForPeriod.income > 0
        ? `${brl(monthInvestedForPeriod)} aportados sobre ${brl(monthTotalsForPeriod.income)} de entradas.`
        : 'Sem receitas no mes para calcular taxa.'
    ),
    dashboardDecisionItemHtml(
      patrimonyUntilCutoff >= 0 ? 'ok' : 'warn',
      'Patrimonio ate corte',
      brl(patrimonyUntilCutoff),
      `Caixa acumulado + ${brl(investedUntilCutoff)} em aportes ate ${dateBR(period.cutoff)}.`
    ),
  ];
  if (budgetRiskForPeriod) {
    itemsForPeriod.push(
      dashboardDecisionItemHtml(
        budgetRiskForPeriod.pct >= 100 ? 'warn' : 'info',
        'Orcamento',
        `${Math.round(budgetRiskForPeriod.pct)}%`,
        `${budgetRiskForPeriod.category} ja consumiu ${brl(budgetRiskForPeriod.used)} de ${brl(budgetRiskForPeriod.limit)}.`
      )
    );
  }
  container.innerHTML = itemsForPeriod.join('');
  return;
  }
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
  const budgetRisk = budgetUsageRows().find((row) => row.pct >= 80)!;

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

  container!.innerHTML = items.join('');
}

function renderKPIs(): void {
  const period = dashboardPeriod();
  const periodTxns = transactionsInPeriod(period);
  const periodInvestments = investmentsInPeriod(period);
  const { income, expense, balance } = computeTotals(periodTxns);
  getEl('kpiBalance').textContent = brl(balance);
  getEl('kpiIncome').textContent = brl(income);
  getEl('kpiExpense').textContent = brl(expense);
  getEl('kpiInvested').textContent = brl(totalInvestedUntil(period.cutoff));
  getEl('kpiCount').textContent = String(periodTxns.length + periodInvestments.length);
  renderDashboardPeriodControls();
  renderPatrimonyGoalStrip();
  renderDashboardInsights();
  renderDashboardDecisionCenter();
  renderBehaviorPartner();
}

function renderDashboardRecent(): void {
  const container = getEl('dashboardRecent');
  const period = dashboardPeriod();
  const items = mergedCashRowsSorted()
    .filter((row) => {
      const d = row.kind === 'txn' ? txnPeriodDate(row.t) : row.inv.date;
      return (d ?? '') >= period.start && (d ?? '') <= period.end;
    })
    .slice(0, 8);
  if (!items.length) {
    container.innerHTML = '<div class="empty">Nenhum lancamento neste periodo.</div>';
    return;
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
  const period = cashflowPeriod();
  return mergedCashRowsSorted().filter((row) => {
    const rowDate = row.kind === 'txn' ? txnPeriodDate(row.t) : row.inv.date;
    if ((rowDate ?? '') < period.start || (rowDate ?? '') > period.end) return false;
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
  const period = cashflowPeriod();
  const today = new Date().toISOString().slice(0, 10);
  const weekStart = period.isCurrentMonth ? today : period.start;
  const weekEnd = period.isCurrentMonth ? addDaysIso(today, 7) : period.end;
  const periodTxns = transactionsInPeriod(period);
  const periodInvestments = investmentsInPeriod(period);
  const pendingPayables = periodTxns.filter((t) => t.type === 'saida' && isTxnPending(t));
  const pendingReceivables = periodTxns.filter((t) => t.type === 'entrada' && isTxnPending(t));
  const overdue = periodTxns.filter((t) => isTxnOverdue(t, today));
  const dueWeek = pendingPayables.filter((t) => {
    const due = txnDueKey(t);
    return due >= weekStart && due <= weekEnd;
  });
  const sum = (rows: Transaction[]) => rows.reduce((total, t) => total + Number(t.amount ?? 0), 0);
  const invested = periodInvestments.reduce((total, inv) => total + Number(inv.amount ?? 0), 0);
  container.innerHTML = [
    `<div class="cashflow-stat cashflow-stat--danger"><span><i aria-hidden="true">!</i>A pagar</span><strong>${brl(sum(pendingPayables))}</strong><p>${pendingPayables.length} compromisso(s) pendente(s)</p></div>`,
    `<div class="cashflow-stat cashflow-stat--success"><span><i aria-hidden="true">↓</i>A receber</span><strong>${brl(sum(pendingReceivables))}</strong><p>${pendingReceivables.length} entrada(s) pendente(s)</p></div>`,
    `<div class="cashflow-stat cashflow-stat--warn"><span><i aria-hidden="true">⌁</i>Atrasados</span><strong>${brl(sum(overdue))}</strong><p>${overdue.length} item(ns) fora do prazo</p></div>`,
    `<div class="cashflow-stat cashflow-stat--info"><span><i aria-hidden="true">7</i>Prox. 7 dias</span><strong>${brl(sum(dueWeek))}</strong><p>${dueWeek.length} despesa(s) no periodo</p></div>`,
    `<div class="cashflow-stat cashflow-stat--invest"><span><i aria-hidden="true">$</i>Aportes</span><strong>${brl(invested)}</strong><p>${periodInvestments.length} registro(s) de investimento</p></div>`,
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
  /** «Tipo» da planilha (Receita/Despesa). «Natureza» é fixa/variável (outro índice). */
  const typeIdx = findCsvColumn(headers, ['tipo', 'type', 'fluxo', 'tipolancamento', 'entradasaida']);
  const recIdx = findCsvColumn(headers, ['natureza', 'recorrencia', 'recorrente', 'fixo']);
  const catIdx = findCsvColumn(headers, ['categoria', 'category', 'classificacao']);
  const bankIdx = findCsvColumn(headers, ['banco', 'conta', 'bank']);
  if (dataIdx < 0 || amountIdx < 0) return [];
  const today = new Date().toISOString().slice(0, 10);
  return rows.slice(1).flatMap((cols): CsvImportRow[] => {
    const date = parseCsvDate(cols[dataIdx] ?? '');
    const amountRaw = parseCsvMoney(cols[amountIdx] ?? '');
    if (!date || !Number.isFinite(amountRaw) || amountRaw < 0) return [];
    const typeRaw = typeIdx >= 0 ? (cols[typeIdx] ?? '').toLowerCase() : '';
    const explicitSaida =
      typeRaw.includes('despesa') || typeRaw.includes('saida') || typeRaw.includes('saída') || typeRaw.includes('debito');
    const explicitEntrada =
      typeRaw.includes('entrada') || typeRaw.includes('receita') || typeRaw.includes('credito');
    const type: TxnType = explicitSaida
      ? 'saida'
      : explicitEntrada || amountRaw > 0
        ? 'entrada'
        : 'saida';
    if (amountRaw === 0 && type === 'entrada') return [];
    const description = (cols[descIdx] ?? '').trim();
    const category = (cols[catIdx] ?? '').trim();
    const bankText = (cols[bankIdx] ?? '').trim().toLowerCase();
    const bank = bankText
      ? state.banks.find(
          (b) => bankOptionLabel(b).toLowerCase().includes(bankText) || b.name.toLowerCase().includes(bankText)
        )
      : undefined;
    const bankId = bank?.id ?? (state.banks.length === 1 ? state.banks[0]!.id : '');
    const dueDate = dueIdx >= 0 ? parseCsvDate(cols[dueIdx] ?? '') || date : date;
    const recRaw = (recIdx >= 0 ? cols[recIdx] ?? '' : '').toLowerCase();
    let expenseKind: ExpenseKind | undefined;
    if (recRaw.includes('vari')) expenseKind = 'variavel';
    else if (recRaw.includes('fix')) expenseKind = 'fixa';
    else if (recRaw.includes('cart')) expenseKind = 'cartao';
    const status: TxnStatus | undefined =
      type === 'entrada'
        ? dueDate > today
          ? 'a_receber'
          : 'recebido'
        : dueDate > today
          ? 'a_vencer'
          : 'pago';
    const tx: Transaction = {
      id: uid(),
      bankId,
      type,
      amount: Math.abs(amountRaw),
      date,
      dueDate,
      category,
      method: 'CSV',
      description,
      ...(type === 'saida' && expenseKind ? { expenseKind } : {}),
      ...(status ? { status } : {}),
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

function normalizeAssistantText(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function isoDateFromLocal(d: Date): string {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).toISOString().slice(0, 10);
}

function assistantRelativeDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return isoDateFromLocal(d);
}

function parseAssistantDate(text: string, normalized: string): string {
  const explicit = text.match(/\b(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?\b/);
  if (explicit) {
    const day = Number(explicit[1]);
    const month = Number(explicit[2]);
    const now = new Date();
    const yearRaw = explicit[3] ? Number(explicit[3]) : now.getFullYear();
    const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
    const candidate = new Date(year, month - 1, day, 12);
    if (
      Number.isFinite(candidate.getTime()) &&
      candidate.getFullYear() === year &&
      candidate.getMonth() === month - 1 &&
      candidate.getDate() === day
    ) {
      return isoDateFromLocal(candidate);
    }
  }
  if (/\bontem\b/.test(normalized)) return assistantRelativeDate(-1);
  if (/\b(amanha|amanhã)\b/.test(normalized)) return assistantRelativeDate(1);
  return assistantRelativeDate(0);
}

function parseAssistantAmount(text: string): number {
  const moneyPattern = /(?:r\$\s*)?(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})|\d+(?:,\d{1,2})|\d{1,3}(?:\.\d{3})+|\d+)(?:\s*(?:reais|real))?/gi;
  const matches = [...text.matchAll(moneyPattern)];
  const explicit = matches.find((m) => /r\$|reais|real/i.test(m[0]));
  const source = explicit ? [explicit] : matches;
  const candidates = source
    .filter((m) => {
      const before = text[(m.index ?? 0) - 1] ?? '';
      const after = text[(m.index ?? 0) + m[0].length] ?? '';
      return before !== '/' && after !== '/' && before !== '-' && after !== '-';
    })
    .map((m) => parseMoneyBRL(m[1]))
    .filter((n) => Number.isFinite(n) && n > 0);
  return candidates.length ? candidates[candidates.length - 1] : NaN;
}

function inferAssistantType(normalized: string): TxnType {
  const incomeTerms = /\b(recebi|receita|entrada|salario|cliente|venda|freela|freelance|pix recebido|deposito)\b/;
  const expenseTerms = /\b(paguei|pagar|despesa|saida|comprei|gastei|mercado|supermercado|boleto|aluguel|condominio|uber|ifood|restaurante|farmacia|internet|luz|agua|combustivel)\b/;
  if (incomeTerms.test(normalized) && !expenseTerms.test(normalized)) return 'entrada';
  return 'saida';
}

function includesAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function pickCatalogCategory(type: TxnType, normalized: string): string {
  const categories = type === 'entrada' ? state.catalog.incomeCategories : state.catalog.expenseCategories;
  const matchExisting = categories.find((cat) => {
    const c = normalizeAssistantText(cat);
    return c && normalized.includes(c);
  });
  if (matchExisting) return matchExisting;

  const findByName = (needles: string[], fallback: string): string => {
    const found = categories.find((cat) => {
      const c = normalizeAssistantText(cat);
      return needles.some((needle) => c.includes(needle));
    });
    return found ?? fallback;
  };

  if (type === 'entrada') {
    if (includesAny(normalized, ['salario', 'ordenado'])) return findByName(['sal', 'renda'], 'Salario');
    if (includesAny(normalized, ['freela', 'freelance', 'cliente', 'projeto'])) return findByName(['freelance', 'venda'], 'Freelance');
    if (includesAny(normalized, ['venda', 'vendido'])) return findByName(['venda'], 'Vendas');
    return findByName(['outro'], 'Receita');
  }

  if (includesAny(normalized, ['mercado', 'supermercado', 'ifood', 'restaurante', 'padaria', 'almoco', 'jantar'])) {
    return findByName(['aliment'], 'Alimentacao');
  }
  if (includesAny(normalized, ['uber', '99', 'combustivel', 'gasolina', 'onibus', 'metro', 'transporte'])) {
    return findByName(['transport'], 'Transporte');
  }
  if (includesAny(normalized, ['farmacia', 'medico', 'consulta', 'saude'])) return findByName(['saude'], 'Saude');
  if (includesAny(normalized, ['aluguel', 'condominio', 'luz', 'agua', 'casa'])) return findByName(['casa'], 'Casa');
  if (includesAny(normalized, ['internet', 'wifi'])) return findByName(['internet'], 'Internet');
  if (includesAny(normalized, ['cartao', 'credito'])) return findByName(['cart'], 'Cartao de Credito');
  if (includesAny(normalized, ['aporte', 'investimento', 'cdb', 'poupanca'])) return findByName(['invest'], 'Investimento');
  return findByName(['outro'], 'Outros');
}

function pickAssistantMethod(normalized: string): string {
  if (normalized.includes('pix')) return 'Pix';
  if (normalized.includes('debito')) return 'Debito';
  if (normalized.includes('credito') || normalized.includes('cartao')) return 'Cartao';
  if (normalized.includes('dinheiro')) return 'Dinheiro';
  if (normalized.includes('boleto')) return 'Boleto';
  if (normalized.includes('ted')) return 'TED';
  return '';
}

function pickAssistantBank(normalized: string): string {
  const found = state.banks.find((bank) => {
    const labels = [bankOptionLabel(bank), bank.name, bank.note, bank.code].filter((v): v is string => Boolean(v));
    return labels.some((label) => {
      const n = normalizeAssistantText(label);
      if (!n) return false;
      if (normalized.includes(n)) return true;
      const tokens = n
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length > 2 && !['banco', 'conta', 'servicos', 'sem', 'tipo'].includes(token));
      return tokens.some((token) => normalized.includes(token));
    });
  });
  if (found) return found.id;
  return state.banks.length === 1 ? state.banks[0].id : '';
}

function pickAssistantCreditCard(normalized: string): string {
  const found = state.creditCards.find((card) => {
    const labels = [card.name, card.brand].filter(Boolean);
    return labels.some((label) => {
      const n = normalizeAssistantText(label);
      if (!n) return false;
      if (normalized.includes(n)) return true;
      return n
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length > 2 && !['cartao', 'credito'].includes(token))
        .some((token) => normalized.includes(token));
    });
  });
  return found?.id ?? (state.creditCards.length === 1 ? state.creditCards[0]!.id : '');
}

function parseAssistantInstallments(normalized: string): number {
  const match = normalized.match(/\b(?:em\s*)?(\d{1,3})\s*x\b/) ?? normalized.match(/\b(\d{1,3})\s*parcelas?\b/);
  if (!match) return 1;
  const n = Number(match[1]);
  return Number.isFinite(n) ? Math.min(120, Math.max(1, Math.round(n))) : 1;
}

function isAssistantCreditPurchase(normalized: string): boolean {
  return state.creditCards.length > 0 && /\b(cartao|credito|mastercard|visa|elo|amex)\b/.test(normalized);
}

function defaultAssistantStatus(type: TxnType, date: string, normalized: string): TxnStatus {
  const today = assistantRelativeDate(0);
  const future = date > today || includesAny(normalized, ['amanha', 'agendado', 'vou pagar', 'a pagar', 'a receber']);
  if (type === 'entrada') return future ? 'a_receber' : 'recebido';
  return future ? 'a_vencer' : 'pago';
}

function buildAssistantDraft(source: string): AssistantDraft {
  const normalized = normalizeAssistantText(source);
  const type = inferAssistantType(normalized);
  const amount = parseAssistantAmount(source);
  const date = parseAssistantDate(source, normalized);
  const bankId = pickAssistantBank(normalized);
  const category = pickCatalogCategory(type, normalized);
  const method = pickAssistantMethod(normalized);
  const tx: Transaction = {
    id: uid(),
    bankId,
    type,
    amount: Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0,
    date,
    dueDate: date,
    category,
    method,
    description: source.trim().slice(0, 500),
    ...(type === 'saida' ? { expenseKind: 'variavel' as ExpenseKind } : {}),
    status: defaultAssistantStatus(type, date, normalized),
  };
  return { tx, missing: assistantMissingFields(tx), confidence: 0.72, source };
}

function buildAssistantCreditDraft(source: string): AssistantCreditDraft {
  const normalized = normalizeAssistantText(source);
  const amount = parseAssistantAmount(source);
  const date = parseAssistantDate(source, normalized);
  const cardId = pickAssistantCreditCard(normalized);
  const category = pickCatalogCategory('saida', normalized);
  const purchase: CreditCardPurchase = {
    id: uid(),
    cardId,
    date,
    amount: Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0,
    installments: parseAssistantInstallments(normalized),
    category,
    description: source.trim().slice(0, 500),
  };
  return { purchase, missing: assistantCreditMissingFields(purchase), confidence: 0.76, source };
}

function assistantMissingFields(tx: Transaction): string[] {
  const missing: string[] = [];
  if (!tx.amount || !Number.isFinite(tx.amount) || tx.amount <= 0) missing.push('valor');
  if (!tx.date) missing.push('data');
  if (!tx.category.trim()) missing.push('categoria');
  if (state.banks.length > 0 && !tx.bankId) missing.push('conta');
  return missing;
}

function assistantCreditMissingFields(purchase: CreditCardPurchase): string[] {
  const missing: string[] = [];
  if (!purchase.cardId) missing.push('cartao');
  if (!purchase.amount || !Number.isFinite(purchase.amount) || purchase.amount <= 0) missing.push('valor');
  if (!purchase.date) missing.push('data');
  if (!purchase.category.trim()) missing.push('categoria');
  return missing;
}

function renderAssistantPreview(): void {
  const box = document.getElementById('aiEntryPreview');
  if (!box) return;
  if (assistantCreditDraft) {
    const { purchase, missing } = assistantCreditDraft;
    const cardOptions =
      '<option value="">Selecione o cartao</option>' +
      state.creditCards
        .map((card) => `<option value="${esc(card.id)}"${card.id === purchase.cardId ? ' selected' : ''}>${esc(card.name)} - ${esc(card.brand)}</option>`)
        .join('');
    box.classList.remove('hidden');
    box.innerHTML = `
      <div class="ai-preview-head">
        <div>
          <h3>Rascunho de compra no cartao</h3>
          <p>${missing.length ? `Faltou confirmar: ${esc(missing.join(', '))}.` : 'Tudo pronto para registrar no cartao.'}</p>
        </div>
        <span class="ai-confidence">${Math.round(assistantCreditDraft.confidence * 100)}% local</span>
      </div>
      <div class="ai-draft-grid">
        <label>Cartao<select id="aiCreditCard">${cardOptions}</select></label>
        <label>Valor<input id="aiCreditAmount" type="text" value="${purchase.amount > 0 ? esc(formatMoneyInputBR(purchase.amount)) : ''}" placeholder="150,00" /></label>
        <label>Data<input id="aiCreditDate" type="date" value="${esc(purchase.date)}" /></label>
        <label>Parcelas<input id="aiCreditInstallments" type="number" min="1" max="120" value="${esc(purchase.installments)}" /></label>
        <label>Categoria<input id="aiCreditCategory" type="text" value="${esc(purchase.category)}" /></label>
      </div>
      <label class="ai-description">Descricao<textarea id="aiCreditDescription" rows="2">${esc(purchase.description)}</textarea></label>
      <div class="ai-entry-actions">
        <button type="button" class="btn primary" id="btnAiCreditSave">Registrar no cartao</button>
        <button type="button" class="btn ghost" id="btnAiDiscard">Descartar</button>
      </div>
    `;
    return;
  }
  if (!assistantDraft) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  const { tx, missing } = assistantDraft;
  const bankOptions =
    '<option value="">Selecione a conta</option>' +
    state.banks.map((b) => `<option value="${esc(b.id)}"${b.id === tx.bankId ? ' selected' : ''}>${esc(bankOptionLabel(b))}</option>`).join('');
  const typeOptions = `<option value="entrada"${tx.type === 'entrada' ? ' selected' : ''}>Receita</option><option value="saida"${tx.type === 'saida' ? ' selected' : ''}>Despesa</option>`;
  const expenseKindOptions =
    `<option value="variavel"${tx.expenseKind === 'variavel' ? ' selected' : ''}>Variavel</option>` +
    `<option value="fixa"${tx.expenseKind === 'fixa' ? ' selected' : ''}>Fixa</option>` +
    `<option value="cartao"${tx.expenseKind === 'cartao' && !tx.expenseCardId ? ' selected' : ''}>Cartao</option>` +
    state.creditCards
      .map(
        (card) =>
          `<option value="card:${esc(card.id)}"${tx.expenseCardId === card.id ? ' selected' : ''}>${esc(creditCardOptionLabel(card))}</option>`
      )
      .join('');
  box.classList.remove('hidden');
  box.innerHTML = `
    <div class="ai-preview-head">
      <div>
        <h3>Rascunho do lancamento</h3>
        <p>${missing.length ? `Faltou confirmar: ${esc(missing.join(', '))}.` : 'Tudo pronto para salvar.'}</p>
      </div>
      <span class="ai-confidence">${Math.round(assistantDraft.confidence * 100)}% local</span>
    </div>
    <div class="ai-draft-grid">
      <label>Tipo<select id="aiDraftType">${typeOptions}</select></label>
      <label>Conta<select id="aiDraftBank">${bankOptions}</select></label>
      <label>Valor<input id="aiDraftAmount" type="text" value="${tx.amount > 0 ? esc(formatMoneyInputBR(tx.amount)) : ''}" placeholder="150,00" /></label>
      <label>Data<input id="aiDraftDate" type="date" value="${esc(tx.date)}" /></label>
      <label>Categoria<input id="aiDraftCategory" type="text" value="${esc(tx.category)}" /></label>
      <label>Forma<input id="aiDraftMethod" type="text" value="${esc(tx.method)}" placeholder="Pix, cartao..." /></label>
      <label class="${tx.type === 'saida' ? '' : 'hidden'}">Natureza<select id="aiDraftExpenseKind">${expenseKindOptions}</select></label>
    </div>
    <label class="ai-description">Descricao<textarea id="aiDraftDescription" rows="2">${esc(tx.description)}</textarea></label>
    <div class="ai-entry-actions">
      <button type="button" class="btn primary" id="btnAiSave">Salvar lancamento</button>
      <button type="button" class="btn ghost" id="btnAiDiscard">Descartar</button>
    </div>
  `;
}

function syncAssistantDraftFromPreview(): boolean {
  if (!assistantDraft) return false;
  const typeRaw = getEl<HTMLSelectElement>('aiDraftType').value;
  const type: TxnType = isTxnType(typeRaw) ? typeRaw : 'saida';
  const expenseKindRaw = document.getElementById('aiDraftExpenseKind') as HTMLSelectElement | null;
  const expenseKindValue = expenseKindRaw?.value ?? '';
  const expenseCardId = expenseKindValue.startsWith('card:') ? expenseKindValue.slice(5) : undefined;
  const expenseKind =
    expenseCardId && state.creditCards.some((card) => card.id === expenseCardId)
      ? 'cartao'
      : isExpenseKind(expenseKindValue)
        ? expenseKindValue
        : undefined;
  const next: Transaction = {
    ...assistantDraft.tx,
    type,
    bankId: getEl<HTMLSelectElement>('aiDraftBank').value,
    amount: moneyAmountFromUserInput(getEl<HTMLInputElement>('aiDraftAmount').value),
    date: getEl<HTMLInputElement>('aiDraftDate').value,
    dueDate: getEl<HTMLInputElement>('aiDraftDate').value,
    category: getEl<HTMLInputElement>('aiDraftCategory').value.trim(),
    method: getEl<HTMLInputElement>('aiDraftMethod').value.trim(),
    description: getEl<HTMLTextAreaElement>('aiDraftDescription').value.trim().slice(0, 500),
    ...(type === 'saida' && expenseKind ? { expenseKind } : {}),
    ...(type === 'saida' && expenseCardId ? { expenseCardId } : {}),
  };
  if (type === 'entrada') {
    delete next.expenseKind;
    delete next.expenseCardId;
  }
  next.status = defaultAssistantStatus(type, next.date, normalizeAssistantText(assistantDraft.source));
  assistantDraft.tx = next;
  assistantDraft.missing = assistantMissingFields(assistantDraft.tx);
  return true;
}

function syncAssistantCreditDraftFromPreview(): boolean {
  if (!assistantCreditDraft) return false;
  const rawInstallments = Number(getEl<HTMLInputElement>('aiCreditInstallments').value);
  assistantCreditDraft.purchase = {
    ...assistantCreditDraft.purchase,
    cardId: getEl<HTMLSelectElement>('aiCreditCard').value,
    amount: moneyAmountFromUserInput(getEl<HTMLInputElement>('aiCreditAmount').value),
    date: getEl<HTMLInputElement>('aiCreditDate').value,
    installments: Number.isFinite(rawInstallments) ? Math.min(120, Math.max(1, Math.round(rawInstallments))) : 1,
    category: getEl<HTMLInputElement>('aiCreditCategory').value.trim(),
    description: getEl<HTMLTextAreaElement>('aiCreditDescription').value.trim().slice(0, 500),
  };
  assistantCreditDraft.missing = assistantCreditMissingFields(assistantCreditDraft.purchase);
  return true;
}

async function saveAssistantDraft(): Promise<void> {
  if (!syncAssistantDraftFromPreview() || !assistantDraft) return;
  if (assistantDraft.missing.length) {
    renderAssistantPreview();
    toast(`Complete antes de salvar: ${assistantDraft.missing.join(', ')}.`, 'error');
    return;
  }
  if (
    assistantDraft.tx.type === 'saida' &&
    !(await confirmBehaviorGuard(
      `${assistantDraft.tx.category} ${assistantDraft.tx.description} ${assistantDraft.tx.method}`,
      assistantDraft.tx.amount,
      assistantDraft.tx.date
    ))
  ) {
    toast('Lancamento pausado. Voce pode revisar antes de salvar.', 'error');
    return;
  }
  state.transactions.push(assistantDraft.tx);
  assistantDraft = null;
  getEl<HTMLTextAreaElement>('aiEntryText').value = '';
  renderAssistantPreview();
  renderAll();
  switchView('transactions');
  toast('Lancamento criado pelo assistente local.', 'success');
}

async function saveAssistantCreditDraft(): Promise<void> {
  if (!syncAssistantCreditDraftFromPreview() || !assistantCreditDraft) return;
  if (assistantCreditDraft.missing.length) {
    renderAssistantPreview();
    toast(`Complete antes de salvar: ${assistantCreditDraft.missing.join(', ')}.`, 'error');
    return;
  }
  if (
    !(await confirmBehaviorGuard(
      `${assistantCreditDraft.purchase.category} ${assistantCreditDraft.purchase.description} cartao`,
      assistantCreditDraft.purchase.amount,
      assistantCreditDraft.purchase.date
    ))
  ) {
    toast('Compra pausada. Voce pode revisar antes de registrar.', 'error');
    return;
  }
  state.creditCardPurchases.push(assistantCreditDraft.purchase);
  assistantCreditDraft = null;
  getEl<HTMLTextAreaElement>('aiEntryText').value = '';
  renderAssistantPreview();
  renderAll();
  switchView('creditCards');
  toast('Compra registrada no cartao pelo assistente local.', 'success');
}

function renderTransactionsTable(): void {
  const container = getEl('transactionsTable');
  renderCashflowPeriodControls();
  renderCashflowTabs();
  renderCashflowSummary();
  renderCashflowRecurrences();
  const merged = cashflowRowsFiltered();
  if (!merged.length) {
    container.innerHTML = '<div class="empty">Nenhum item encontrado para o filtro atual.</div>';
    return;
  }
  const td = (value: string | number | undefined | null, className = ''): string => {
    const text = esc(value ?? '-');
    return `<td${className ? ` class="${className}"` : ''} title="${text}">${text}</td>`;
  };
  const rowHtml = (r: MergedCashRow): string => {
    if (r.kind === 'txn') {
      const t = r.t;
      const desc = esc(t.description ?? '-');
      const kind = typeLabel(t.type);
      const nature = t.type === 'saida' ? expenseKindLabel(t.expenseKind, t.expenseCardId) : '—';
      const value = brl(t.amount);
      return `<tr>${td(dateBR(t.dueDate))}${td(bankLabelById(t.bankId))}<td title="${esc(kind)}"><span class="${launchTypeTagClass(t.type)}">${esc(kind)}</span></td>${td(nature)}<td>${txnStatusSelectHtml(t)}</td>${td(t.category ?? '-')}<td title="${desc}">${desc}</td>${td(t.method ?? '-')}${td(value, t.type === 'entrada' ? 'positive' : 'negative')}<td><div class="row-actions"><button type="button" class="btn ghost" data-edit-txn="${esc(t.id)}">Editar</button><button type="button" class="btn danger" data-delete-txn="${esc(t.id)}">Excluir</button></div></td></tr>`;
      return `<tr><td>${dateBR(t.date)}</td><td>${dateBR(t.dueDate)}</td><td>${esc(bankLabelById(t.bankId))}</td><td>—</td><td><span class="${launchTypeTagClass(t.type)}">${esc(typeLabel(t.type))}</span></td><td>${t.type === 'saida' ? esc(expenseKindLabel(t.expenseKind, t.expenseCardId)) : '—'}</td><td>${esc(statusLabel(t.status))}</td><td>${esc(t.category ?? '-')}</td><td title="${desc}">${desc}</td><td>${esc(t.method ?? '-')}</td><td class="${t.type === 'entrada' ? 'positive' : 'negative'}">${brl(t.amount)}</td><td><div class="row-actions"><button type="button" class="btn ghost" data-edit-txn="${esc(t.id)}">Editar</button><button type="button" class="btn danger" data-delete-txn="${esc(t.id)}">Excluir</button></div></td></tr>`;
    }
    const inv = r.inv;
    const bid = resolveInvestmentBankId(inv);
    const desc = (inv.notes ?? '').trim() || inv.institution;
    return `<tr>${td(dateBR(inv.date))}${td(bankLabelById(bid || undefined))}<td title="Investimento"><span class="${launchTypeTagClass('investimento')}">Investimento</span></td>${td('�')}<td>�</td>${td(inv.type)}<td title="${esc(desc)}">${esc(desc)}</td>${td('�')}${td(brl(inv.amount), 'kpi-invest-value')}<td><div class="row-actions"><button type="button" class="btn ghost" data-edit-inv="${esc(inv.id)}">Editar</button><button type="button" class="btn danger" data-delete-inv="${esc(inv.id)}">Excluir</button></div></td></tr>`;
    return `<tr><td>${dateBR(inv.date)}</td><td>—</td><td>${esc(bankLabelById(bid || undefined))}</td><td>${esc(savingsGoalDisplayName(inv.savingsGoalId))}</td><td><span class="${launchTypeTagClass('investimento')}">Investimento</span></td><td>—</td><td>—</td><td>${esc(inv.type)}</td><td title="${esc(desc)}">${esc(desc)}</td><td>—</td><td class="kpi-invest-value">${brl(inv.amount)}</td><td><div class="row-actions"><button type="button" class="btn ghost" data-edit-inv="${esc(inv.id)}">Editar</button><button type="button" class="btn danger" data-delete-inv="${esc(inv.id)}">Excluir</button></div></td></tr>`;
  };
  const colgroup =
    '<colgroup>' +
    ['7%', '16%', '7%', '7%', '11%', '8%', '18%', '7%', '9%', '10%']
      .map((w) => `<col style="width:${w}" />`)
      .join('') +
    '</colgroup>';
  container.innerHTML =
    `<table class="table-launch">${colgroup}<thead><tr><th>Venc.</th><th>Banco</th><th>Tipo</th><th>Natureza</th><th>Status</th><th>Cat.</th><th>Descr.</th><th>Forma</th><th>Valor</th><th>Acoes</th></tr></thead><tbody>` +
    merged.map(rowHtml).join('') +
    '</tbody></table>';
  return;
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
  {
    const row = (b: Bank) => {
      const txns = state.transactions.filter((t) => t.bankId === b.id);
      const totals = computeRealizedTotals(txns);
      const { invested: invSum, invCount } = investmentAggForBank(b.id);
      const meta = [normalizedBankAccountType(b), b.code ? `Cod. ${b.code}` : '', b.note ?? ''].filter(Boolean).join(' · ');
      const movLine = invCount > 0 ? `${txns.length} lanc. · ${invCount} aporte(s)` : `${txns.length} lancamento(s)`;
      const totalAtBank = totals.balance + invSum;
      const breakdown =
        invSum > 0 && totals.balance !== 0
          ? `<div class="small muted" style="margin-top:2px">Caixa: <span class="${totals.balance >= 0 ? 'positive' : 'negative'}">${brl(totals.balance)}</span> · Aportes: <span class="kpi-invest-value">${brl(invSum)}</span></div>`
          : '';
      return `<div class="bank-item"><div class="bank-item-main"><strong>${esc(b.name)}</strong><span class="muted small bank-item-meta" title="${esc(meta)}">${esc(meta)}</span></div><div class="bank-item-aside"><div><span class="${totalAtBank >= 0 ? 'positive' : 'negative'}">${brl(totalAtBank)}</span></div>${breakdown}<div class="small muted">${movLine}</div><div class="row-actions bank-item-actions"><button type="button" class="btn ghost" data-edit-bank="${esc(b.id)}">Editar</button><button type="button" class="btn danger" data-delete-bank="${esc(b.id)}">Excluir</button></div></div></div>`;
    };
    const section = (title: string, banks: Bank[]) =>
      banks.length ? `<div class="bank-list-section"><h4>${esc(title)}</h4>${banks.map(row).join('')}</div>` : '';
    container.innerHTML =
      section('Contas correntes e operacionais', operationalBankAccounts()) +
      section('Contas de investimento', investmentBankAccounts());
    return;
  }
  container.innerHTML = state.banks
    .map((b) => {
      const txns = state.transactions.filter((t) => t.bankId === b.id);
      const totals = computeRealizedTotals(txns);
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
  {
    const renderAccountPosition = (title: string, rows: typeof bankRows): string => {
      if (!rows.length) return '';
      return (
        `<div class="report-account-section"><h4>${esc(title)}</h4>` +
        '<table><thead><tr><th>Conta</th><th>Caixa</th><th>Investimentos</th><th>Total</th><th>Movimentos</th></tr></thead><tbody>' +
        rows
          .map((r) => {
            const total = r.balance + r.invested;
            return `<tr><td><span class="bank-summary-name" title="${esc(bankFullDetailLabel(r.bank))}">${esc(bankInstitutionDisplayName(r.bank))}</span><br><span class="muted small">${esc(normalizedBankAccountType(r.bank))}</span></td><td class="${r.balance >= 0 ? 'positive' : 'negative'}">${brl(r.balance)}</td><td class="kpi-invest-value">${brl(r.invested)}</td><td class="${total >= 0 ? 'positive' : 'negative'}">${brl(total)}</td><td class="muted small">${r.txnCount} lanc. + ${r.invCount} aport.</td></tr>`;
          })
          .join('') +
        '</tbody></table></div>'
      );
    };
    const sections =
      renderAccountPosition('Contas correntes e operacionais', bankRows.filter((r) => !isInvestmentBankAccount(r.bank) && !/empres/i.test(normalizedBankAccountType(r.bank)))) +
      renderAccountPosition('Contas correntes empresariais', bankRows.filter((r) => !isInvestmentBankAccount(r.bank) && /empres/i.test(normalizedBankAccountType(r.bank)))) +
      renderAccountPosition('Contas investimento', bankRows.filter((r) => normalizedBankAccountType(r.bank) === 'Conta investimento')) +
      renderAccountPosition('Contas investimento empresariais', bankRows.filter((r) => normalizedBankAccountType(r.bank) === 'Conta investimento empresarial'));
    byBank.innerHTML = sections || '<div class="empty">Sem dados para exibir.</div>';
  }
  if (false) byBank.innerHTML = bankRows.length
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
        `<tr><td>${dateBR(txnVencimentoKey(t)!)}</td><td>${dateBR(t.date)}</td><td>${esc(expenseKindLabel(t.expenseKind, t.expenseCardId))}</td><td>${esc(t.category ?? '—')}</td><td class="negative">${brl(t.amount)}</td><td>${esc(bankLabelById(t.bankId))}</td><td>${esc(t.description || '—')}</td></tr>`
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

type CreditInvoiceLine = {
  card: CreditCard;
  purchase: CreditCardPurchase;
  installmentNo: number;
  amount: number;
  closingDate: string;
  dueDate: string;
};

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0, 12).getDate();
}

function isoInMonth(year: number, monthIndex: number, day: number): string {
  const d = Math.min(Math.max(1, day), daysInMonth(year, monthIndex));
  return new Date(year, monthIndex, d, 12).toISOString().slice(0, 10);
}

function creditInvoiceDates(card: CreditCard, purchaseDate: string, installmentIndex: number): { closingDate: string; dueDate: string } {
  const base = new Date(`${purchaseDate}T12:00:00`);
  const purchaseDay = base.getDate();
  const closingOffset = purchaseDay > card.closingDay ? 1 : 0;
  const closingMonth = base.getMonth() + closingOffset + installmentIndex;
  const closingYear = base.getFullYear() + Math.floor(closingMonth / 12);
  const closingMonthIndex = ((closingMonth % 12) + 12) % 12;
  const dueOffset = card.dueDay <= card.closingDay ? 1 : 0;
  const dueMonth = closingMonth + dueOffset;
  const dueYear = base.getFullYear() + Math.floor(dueMonth / 12);
  const dueMonthIndex = ((dueMonth % 12) + 12) % 12;
  return {
    closingDate: isoInMonth(closingYear, closingMonthIndex, card.closingDay),
    dueDate: isoInMonth(dueYear, dueMonthIndex, card.dueDay),
  };
}

function creditInstallmentAmount(purchase: CreditCardPurchase, installmentIndex: number): number {
  const totalCents = Math.round(purchase.amount * 100);
  const base = Math.floor(totalCents / purchase.installments);
  const remainder = totalCents % purchase.installments;
  return (base + (installmentIndex < remainder ? 1 : 0)) / 100;
}

function creditInvoiceLines(): CreditInvoiceLine[] {
  const lines: CreditInvoiceLine[] = [];
  for (const purchase of state.creditCardPurchases) {
    const card = state.creditCards.find((c) => c.id === purchase.cardId);
    if (!card) continue;
    for (let i = 0; i < purchase.installments; i += 1) {
      const dates = creditInvoiceDates(card, purchase.date, i);
      lines.push({
        card,
        purchase,
        installmentNo: i + 1,
        amount: creditInstallmentAmount(purchase, i),
        ...dates,
      });
    }
  }
  return lines.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.card.name.localeCompare(b.card.name));
}

function currentCreditInvoiceDue(lines = creditInvoiceLines()): string | null {
  const today = new Date().toISOString().slice(0, 10);
  const future = lines.find((line) => line.dueDate >= today && creditInvoiceOpenAmount(line.card.id, line.dueDate, lines) > 0);
  return future?.dueDate ?? lines.at(-1)?.dueDate ?? null;
}

function creditInvoiceTotal(cardId: string, dueDate: string, lines = creditInvoiceLines()): number {
  return lines
    .filter((line) => line.card.id === cardId && line.dueDate === dueDate)
    .reduce((sum, line) => sum + line.amount, 0);
}

function creditInvoicePaid(cardId: string, dueDate: string): number {
  return state.creditCardPayments
    .filter((payment) => payment.cardId === cardId && payment.invoiceDueDate === dueDate)
    .reduce((sum, payment) => sum + payment.amount, 0);
}

function creditInvoiceOpenAmount(cardId: string, dueDate: string, lines = creditInvoiceLines()): number {
  return Math.max(0, creditInvoiceTotal(cardId, dueDate, lines) - creditInvoicePaid(cardId, dueDate));
}

function creditInvoiceOptions(lines = creditInvoiceLines()): { cardId: string; dueDate: string; label: string; open: number }[] {
  const seen = new Set<string>();
  return lines.flatMap((line) => {
    const key = `${line.card.id}|${line.dueDate}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const open = creditInvoiceOpenAmount(line.card.id, line.dueDate, lines);
    if (open <= 0) return [];
    return [{ cardId: line.card.id, dueDate: line.dueDate, label: `${line.card.name} - ${dateBR(line.dueDate)} - ${brl(open)}`, open }];
  });
}

function creditCardUsed(cardId: string): number {
  const lines = creditInvoiceLines();
  const dueDates = [...new Set(lines.filter((line) => line.card.id === cardId).map((line) => line.dueDate))];
  return dueDates.reduce((sum, dueDate) => sum + creditInvoiceOpenAmount(cardId, dueDate, lines), 0);
}

function populateCreditCardControls(): void {
  const bank = document.getElementById('creditCardBank') as HTMLSelectElement | null;
  const opBanks = operationalBankAccounts();
  const bankOptions =
    '<option value="">Sem conta vinculada</option>' +
    opBanks.map((b) => `<option value="${esc(b.id)}">${esc(bankOptionLabel(b))}</option>`).join('');
  if (bank) {
    bank.innerHTML = bankOptions;
  }
  const card = document.getElementById('creditPurchaseCard') as HTMLSelectElement | null;
  const cardOptions = state.creditCards.length
    ? '<option value="">Selecione o cartao</option>' +
      state.creditCards.map((c) => `<option value="${esc(c.id)}">${esc(c.name)} - ${esc(c.brand)}</option>`).join('')
    : '<option value="">Cadastre um cartao primeiro</option>';
  if (card) {
    card.innerHTML = cardOptions;
  }
  const simCard = document.getElementById('creditSimCard') as HTMLSelectElement | null;
  if (simCard) {
    const current = simCard.value;
    simCard.innerHTML = cardOptions;
    if (current && state.creditCards.some((c) => c.id === current)) simCard.value = current;
  }
  const paymentCard = document.getElementById('creditPaymentCard') as HTMLSelectElement | null;
  if (paymentCard) {
    const current = paymentCard.value;
    paymentCard.innerHTML = cardOptions;
    if (current && state.creditCards.some((c) => c.id === current)) paymentCard.value = current;
  }
  const paymentBank = document.getElementById('creditPaymentBank') as HTMLSelectElement | null;
  if (paymentBank) {
    const current = paymentBank.value;
    paymentBank.innerHTML =
      '<option value="">Selecione a conta</option>' +
      opBanks.map((b) => `<option value="${esc(b.id)}">${esc(bankOptionLabel(b))}</option>`).join('');
    if (current && opBanks.some((b) => b.id === current)) paymentBank.value = current;
  }
  const date = document.getElementById('creditPurchaseDate') as HTMLInputElement | null;
  if (date && !date.value) date.value = new Date().toISOString().slice(0, 10);
  const simDate = document.getElementById('creditSimDate') as HTMLInputElement | null;
  if (simDate && !simDate.value) simDate.value = new Date().toISOString().slice(0, 10);
  const paymentDate = document.getElementById('creditPaymentDate') as HTMLInputElement | null;
  if (paymentDate && !paymentDate.value) paymentDate.value = new Date().toISOString().slice(0, 10);
  const categoryList = document.getElementById('creditCategoryList') as HTMLDataListElement | null;
  if (categoryList) {
    categoryList.innerHTML = state.catalog.expenseCategories.map((c) => `<option value="${esc(c)}"></option>`).join('');
  }
  refreshCreditPaymentInvoices();
}

function refreshCreditPaymentInvoices(): void {
  const invoice = document.getElementById('creditPaymentInvoice') as HTMLSelectElement | null;
  if (!invoice) return;
  const cardId = (document.getElementById('creditPaymentCard') as HTMLSelectElement | null)?.value ?? '';
  const options = creditInvoiceOptions().filter((opt) => !cardId || opt.cardId === cardId);
  const current = invoice.value;
  invoice.innerHTML = options.length
    ? '<option value="">Selecione a fatura</option>' +
      options.map((opt) => `<option value="${esc(`${opt.cardId}|${opt.dueDate}`)}">${esc(opt.label)}</option>`).join('')
    : '<option value="">Nenhuma fatura em aberto</option>';
  if (current && options.some((opt) => `${opt.cardId}|${opt.dueDate}` === current)) invoice.value = current;
  syncCreditPaymentAmount();
}

function syncCreditPaymentAmount(): void {
  const invoice = document.getElementById('creditPaymentInvoice') as HTMLSelectElement | null;
  const amount = document.getElementById('creditPaymentAmount') as HTMLInputElement | null;
  if (!invoice || !amount || !invoice.value) return;
  const [cardId, dueDate] = invoice.value.split('|');
  if (!cardId || !dueDate) return;
  amount.value = formatMoneyInputBR(creditInvoiceOpenAmount(cardId, dueDate));
}

function renderCreditSimulator(): void {
  const box = document.getElementById('creditSimulationResult');
  if (!box) return;
  const cardId = (document.getElementById('creditSimCard') as HTMLSelectElement | null)?.value ?? '';
  const date = (document.getElementById('creditSimDate') as HTMLInputElement | null)?.value ?? '';
  const amountRaw = (document.getElementById('creditSimAmount') as HTMLInputElement | null)?.value ?? '';
  const installmentsRaw = Number((document.getElementById('creditSimInstallments') as HTMLInputElement | null)?.value ?? '1');
  const amount = moneyAmountFromUserInput(amountRaw);
  const installments = Number.isFinite(installmentsRaw) ? Math.min(120, Math.max(1, Math.round(installmentsRaw))) : 1;
  const card = state.creditCards.find((c) => c.id === cardId);
  if (!state.creditCards.length) {
    box.innerHTML = '<div class="empty">Cadastre um cartao para simular compras parceladas.</div>';
    return;
  }
  if (!card || !date || amount <= 0) {
    box.innerHTML = '<p class="muted small">Preencha cartao, data, valor e parcelas para ver o impacto nas faturas.</p>';
    return;
  }
  const fake: CreditCardPurchase = {
    id: 'sim',
    cardId: card.id,
    date,
    amount,
    installments,
    category: '',
    description: 'Simulacao',
  };
  const lines = Array.from({ length: installments }, (_, i) => {
    const dates = creditInvoiceDates(card, date, i);
    const value = creditInstallmentAmount(fake, i);
    const openBefore = creditInvoiceOpenAmount(card.id, dates.dueDate);
    return { installmentNo: i + 1, ...dates, value, openBefore, openAfter: openBefore + value };
  });
  const cardUsed = creditCardUsed(card.id);
  const projectedUsed = cardUsed + amount;
  const projectedPct = card.limit > 0 ? (projectedUsed / card.limit) * 100 : 0;
  const pressureClass = projectedPct >= 90 ? 'negative' : projectedPct >= 70 ? 'kpi-invest-value' : 'positive';
  box.innerHTML =
    `<div class="credit-sim-summary"><strong class="${pressureClass}">${brl(projectedUsed)} comprometidos</strong><span class="muted small">Depois desta compra, uso estimado do limite: ${Math.round(projectedPct)}%.</span></div>` +
    '<div class="table-wrap"><table><thead><tr><th>Fatura</th><th>Parcela</th><th>Antes</th><th>Depois</th></tr></thead><tbody>' +
    lines
      .slice(0, 12)
      .map(
        (line) =>
          `<tr><td>${dateBR(line.dueDate)}</td><td>${line.installmentNo}/${installments} - ${brl(line.value)}</td><td>${brl(line.openBefore)}</td><td class="negative">${brl(line.openAfter)}</td></tr>`
      )
      .join('') +
    '</tbody></table></div>' +
    (installments > 12 ? `<p class="muted small">Mostrando as 12 primeiras parcelas de ${installments}.</p>` : '');
}

function averageMonthlyIncome(lastMonths = 3): number {
  const now = new Date();
  let total = 0;
  for (let i = 0; i < lastMonths; i += 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1, 12);
    total += monthIncomeExpense(d.getFullYear(), d.getMonth()).income;
  }
  return total / lastMonths;
}

function renderCreditRadar(lines = creditInvoiceLines()): void {
  const box = document.getElementById('creditRadar');
  if (!box) return;
  if (!state.creditCards.length) {
    box.innerHTML = '<div class="empty">Cadastre cartoes para receber alertas de fatura e limite.</div>';
    return;
  }
  const alerts: { kind: 'ok' | 'warn' | 'info'; title: string; detail: string }[] = [];
  const totalLimit = state.creditCards.reduce((sum, card) => sum + card.limit, 0);
  const used = state.creditCards.reduce((sum, card) => sum + creditCardUsed(card.id), 0);
  const usedPct = totalLimit > 0 ? (used / totalLimit) * 100 : 0;
  if (usedPct >= 90) {
    alerts.push({ kind: 'warn', title: 'Limite quase no teto', detail: `${Math.round(usedPct)}% do limite total esta comprometido.` });
  } else if (usedPct >= 70) {
    alerts.push({ kind: 'info', title: 'Uso elevado do limite', detail: `${Math.round(usedPct)}% do limite total ja esta comprometido.` });
  } else {
    alerts.push({ kind: 'ok', title: 'Limite saudavel', detail: `${Math.round(usedPct)}% do limite total esta comprometido.` });
  }

  const currentDue = currentCreditInvoiceDue(lines);
  if (currentDue) {
    const open = state.creditCards.reduce((sum, card) => sum + creditInvoiceOpenAmount(card.id, currentDue, lines), 0);
    const today = new Date();
    const due = new Date(`${currentDue}T12:00:00`);
    const days = Math.ceil((due.getTime() - today.getTime()) / 86400000);
    alerts.push({
      kind: days <= 3 ? 'warn' : 'info',
      title: days < 0 ? 'Fatura vencida' : days <= 3 ? 'Fatura perto do vencimento' : 'Proxima fatura',
      detail: `${brl(open)} em aberto para ${dateBR(currentDue)}${days >= 0 ? ` (${days} dia(s))` : ''}.`,
    });
  }

  const avgIncome = averageMonthlyIncome();
  if (avgIncome > 0 && currentDue) {
    const open = state.creditCards.reduce((sum, card) => sum + creditInvoiceOpenAmount(card.id, currentDue, lines), 0);
    const pressure = (open / avgIncome) * 100;
    alerts.push({
      kind: pressure >= 35 ? 'warn' : pressure >= 20 ? 'info' : 'ok',
      title: 'Pressao sobre renda',
      detail: `A proxima fatura representa ${Math.round(pressure)}% da media de receitas dos ultimos 3 meses.`,
    });
  } else {
    alerts.push({
      kind: 'info',
      title: 'Renda sem base',
      detail: 'Registre receitas no Fluxo de Caixa para medir a pressao da fatura sobre a renda.',
    });
  }

  box.innerHTML = alerts
    .map(
      (alert) =>
        `<div class="credit-radar-item credit-radar-item--${alert.kind}"><strong>${esc(alert.title)}</strong><p>${esc(alert.detail)}</p></div>`
    )
    .join('');
}

function renderCreditCards(): void {
  populateCreditCardControls();
  renderCreditSimulator();
  const lines = creditInvoiceLines();
  renderCreditRadar(lines);
  const totalLimit = state.creditCards.reduce((sum, card) => sum + card.limit, 0);
  const used = state.creditCards.reduce((sum, card) => sum + creditCardUsed(card.id), 0);
  const currentDue = currentCreditInvoiceDue(lines);
  const currentTotal = currentDue
    ? state.creditCards.reduce((sum, card) => sum + creditInvoiceOpenAmount(card.id, currentDue, lines), 0)
    : 0;
  getEl('creditLimitTotal').textContent = brl(totalLimit);
  getEl('creditLimitUsed').textContent = brl(used);
  getEl('creditLimitAvailable').textContent = brl(Math.max(0, totalLimit - used));
  getEl('creditCurrentInvoice').textContent = brl(currentTotal);
  getEl('creditCurrentInvoiceHint').textContent = currentDue ? `Vencimento ${dateBR(currentDue)}` : 'Sem fatura aberta';

  const list = getEl('creditCardsList');
  if (!state.creditCards.length) {
    list.innerHTML = '<div class="empty">Cadastre seu primeiro cartao para acompanhar limite e faturas.</div>';
  } else {
    list.innerHTML = state.creditCards
      .map((card) => {
        const cardUsed = creditCardUsed(card.id);
        const pct = card.limit > 0 ? Math.min(100, (cardUsed / card.limit) * 100) : 0;
        return `<div class="credit-card-item"><div class="credit-card-main"><strong>${esc(card.name)}</strong><span class="muted small">${esc(card.brand)} - fecha dia ${card.closingDay}, vence dia ${card.dueDay}${card.bankId ? ` - ${esc(bankLabelById(card.bankId))}` : ''}</span><div class="bar credit-limit-bar"><span style="width:${pct}%"></span></div></div><div class="credit-card-aside"><strong>${brl(card.limit - cardUsed)}</strong><span class="muted small">disponivel de ${brl(card.limit)} - aberto ${brl(cardUsed)}</span><div class="row-actions credit-card-actions"><button type="button" class="btn danger" data-delete-credit-card="${esc(card.id)}">Excluir</button></div></div></div>`;
      })
      .join('');
  }

  const table = getEl('creditInvoicesTable');
  if (!lines.length) {
    table.innerHTML = '<div class="empty">Nenhuma compra registrada no cartao.</div>';
    return;
  }
  table.innerHTML =
    '<table><thead><tr><th>Vencimento</th><th>Cartao</th><th>Compra</th><th>Parcela</th><th>Categoria</th><th>Valor</th><th>Status</th><th>Acoes</th></tr></thead><tbody>' +
    lines
      .map(
        (line) => {
          const invoiceOpen = creditInvoiceOpenAmount(line.card.id, line.dueDate, lines);
          const status = invoiceOpen <= 0 ? '<span class="positive">Fatura paga</span>' : `<span class="negative">Aberto ${brl(invoiceOpen)}</span>`;
          return `<tr><td>${dateBR(line.dueDate)}</td><td>${esc(line.card.name)}</td><td>${esc(line.purchase.description || '-')}<br><span class="muted small">Compra ${dateBR(line.purchase.date)} - fecha ${dateBR(line.closingDate)}</span></td><td>${line.installmentNo}/${line.purchase.installments}</td><td>${esc(line.purchase.category || '-')}</td><td class="negative">${brl(line.amount)}</td><td>${status}</td><td><button type="button" class="btn danger" data-delete-credit-purchase="${esc(line.purchase.id)}">Excluir</button></td></tr>`;
        }
      )
      .join('') +
    '</tbody></table>';
}

function createCreditCard(): void {
  const name = getEl<HTMLInputElement>('creditCardName').value.trim();
  const brand = getEl<HTMLSelectElement>('creditCardBrand').value;
  const limit = moneyAmountFromUserInput(getEl<HTMLInputElement>('creditCardLimit').value);
  const bankId = getEl<HTMLSelectElement>('creditCardBank').value;
  const closingDay = normalizeDay(getEl<HTMLInputElement>('creditCardClosingDay').value, 25);
  const dueDay = normalizeDay(getEl<HTMLInputElement>('creditCardDueDay').value, 10);
  if (!name || limit <= 0) {
    toast('Informe nome do cartao e limite valido.', 'error');
    return;
  }
  state.creditCards.push({
    id: uid(),
    name,
    ...(bankId ? { bankId } : {}),
    brand,
    limit,
    closingDay,
    dueDay,
  });
  getEl<HTMLInputElement>('creditCardName').value = '';
  getEl<HTMLInputElement>('creditCardLimit').value = '';
  getEl<HTMLInputElement>('creditCardClosingDay').value = '25';
  getEl<HTMLInputElement>('creditCardDueDay').value = '10';
  renderAll();
  toast('Cartao cadastrado.', 'success');
}

async function createCreditPurchase(): Promise<void> {
  const cardId = getEl<HTMLSelectElement>('creditPurchaseCard').value;
  const date = getEl<HTMLInputElement>('creditPurchaseDate').value;
  const amount = moneyAmountFromUserInput(getEl<HTMLInputElement>('creditPurchaseAmount').value);
  const rawInstallments = Number(getEl<HTMLInputElement>('creditPurchaseInstallments').value);
  const installments = Number.isFinite(rawInstallments) ? Math.min(120, Math.max(1, Math.round(rawInstallments))) : 1;
  const category = getEl<HTMLInputElement>('creditPurchaseCategory').value.trim();
  const description = getEl<HTMLInputElement>('creditPurchaseDescription').value.trim().slice(0, 500);
  if (!state.creditCards.length) {
    toast('Cadastre um cartao antes de registrar compras.', 'error');
    return;
  }
  if (!cardId || !date || amount <= 0) {
    toast('Informe cartao, data e valor valido.', 'error');
    return;
  }
  if (!(await confirmBehaviorGuard(`${category} ${description} cartao`, amount, date))) {
    toast('Compra pausada. Voce pode revisar antes de registrar.', 'error');
    return;
  }
  state.creditCardPurchases.push({
    id: uid(),
    cardId,
    date,
    description,
    category,
    amount,
    installments,
  });
  getEl<HTMLInputElement>('creditPurchaseAmount').value = '';
  getEl<HTMLInputElement>('creditPurchaseInstallments').value = '1';
  getEl<HTMLInputElement>('creditPurchaseCategory').value = '';
  getEl<HTMLInputElement>('creditPurchaseDescription').value = '';
  renderAll();
  toast('Compra registrada no cartao.', 'success');
}

function payCreditInvoice(): void {
  const invoiceRaw = getEl<HTMLSelectElement>('creditPaymentInvoice').value;
  const [cardId, invoiceDueDate] = invoiceRaw.split('|');
  const card = state.creditCards.find((c) => c.id === cardId);
  const bankId = getEl<HTMLSelectElement>('creditPaymentBank').value;
  const date = getEl<HTMLInputElement>('creditPaymentDate').value;
  const amount = moneyAmountFromUserInput(getEl<HTMLInputElement>('creditPaymentAmount').value);
  if (!card || !invoiceDueDate) {
    toast('Selecione a fatura para pagamento.', 'error');
    return;
  }
  if (!state.banks.length || !bankId) {
    toast('Selecione a conta de pagamento da fatura.', 'error');
    return;
  }
  if (!date || amount <= 0) {
    toast('Informe data e valor pago validos.', 'error');
    return;
  }
  const open = creditInvoiceOpenAmount(cardId, invoiceDueDate);
  if (open <= 0) {
    toast('Esta fatura ja esta paga.', 'error');
    return;
  }
  if (amount > open + 0.009) {
    toast(`O valor pago nao pode passar do aberto (${brl(open)}).`, 'error');
    return;
  }
  const txId = uid();
  const tx: Transaction = {
    id: txId,
    bankId,
    type: 'saida',
    amount,
    date,
    dueDate: date,
    category: 'Cartao de Credito',
    method: 'Fatura',
    description: `Pagamento fatura ${card.name} venc. ${dateBR(invoiceDueDate)}`,
    expenseKind: 'variavel',
    status: 'pago',
  };
  state.transactions.push(tx);
  state.creditCardPayments.push({
    id: uid(),
    cardId,
    invoiceDueDate,
    bankId,
    date,
    amount,
    transactionId: txId,
  });
  getEl<HTMLInputElement>('creditPaymentAmount').value = '';
  renderAll();
  toast('Fatura paga e lancamento criado no Fluxo de Caixa.', 'success');
}

function deleteCreditCard(id: string): void {
  const purchases = state.creditCardPurchases.filter((p) => p.cardId === id).length;
  const payments = state.creditCardPayments.filter((p) => p.cardId === id).length;
  const msg =
    purchases || payments
      ? 'Este cartao possui compras ou pagamentos. Excluir cartao e registros vinculados?'
      : 'Excluir este cartao?';
  if (!confirm(msg)) return;
  state.creditCards = state.creditCards.filter((card) => card.id !== id);
  state.creditCardPurchases = state.creditCardPurchases.filter((p) => p.cardId !== id);
  state.creditCardPayments = state.creditCardPayments.filter((p) => p.cardId !== id);
  state.transactions = state.transactions.map((t) => {
    if (t.expenseCardId !== id) return t;
    const { expenseCardId: _expenseCardId, ...rest } = t;
    return rest;
  });
  renderAll();
  toast('Cartao removido.', 'success');
}

function deleteCreditPurchase(id: string): void {
  if (!confirm('Excluir esta compra do cartao?')) return;
  state.creditCardPurchases = state.creditCardPurchases.filter((p) => p.id !== id);
  renderAll();
  toast('Compra removida.', 'success');
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
  {
    const sel = document.getElementById('invBank') as HTMLSelectElement | null;
    if (!sel) return;
    const inv = investmentBankAccounts();
    const op = operationalBankAccounts();
    const group = (label: string, banks: Bank[]) =>
      banks.length
        ? `<optgroup label="${esc(label)}">${banks.map((b) => `<option value="${esc(b.id)}">${esc(bankOptionLabel(b))}</option>`).join('')}</optgroup>`
        : '';
    sel.innerHTML = '<option value="">-- Sem vinculo</option>' + group('Contas investimento', inv) + group('Outras contas', op);
    return;
  }
  const sel = document.getElementById('invBank') as HTMLSelectElement;
  if (!sel) return;
  const head = '<option value="">— Sem vínculo</option>';
  if (sel) sel.innerHTML = state.banks.length
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
  fillTxnPaymentSourceSelect(getTxnModalMode(), getEl<HTMLSelectElement>('txnBank').value);
  return;
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
  renderCreditCards();
  renderReports();
  renderCatalogList();
  renderCadastrosLists();
  renderInvestmentsTable();
  renderBehaviorView();
  renderSidebarTip();
  renderSidebarEducationTip();
  refreshInvTypeDatalist();
  syncAuthSettingsVisibility();
}

const VIEW_META: Record<ViewId, [string, string]> = {
  dashboard: ['Dashboard', 'Cockpit financeiro com indicadores, alertas e posicao consolidada.'],
  transactions: ['Fluxo de Caixa', 'Operacao diaria: entradas, saidas, vencimentos, importacao e recorrencias.'],
  creditCards: ['Cartoes', 'Limite, faturas, compras parceladas e compromissos futuros.'],
  behavior: ['Comportamento', 'Habitos financeiros, sinais de impulso e conselhos para proteger seu caixa.'],
  budgets: ['Orcamentos', 'Limites mensais por categoria, risco de estouro e alertas no dashboard.'],
  banks: ['Contas', 'Instituicoes, tipos de conta e posicao consolidada por banco.'],
  investments: ['Metas e Aportes', 'Aportes, metas, posicao por conta e evolucao do patrimonio.'],
  reports: ['Relatorios', 'Analise por banco, categoria, mes e ano.'],
  settings: ['Configuracoes', 'Categorias, contas, cartoes, backup, protecao local por senha e exportacao dos dados.'],
};

function switchView(view: ViewId): void {
  showMobileView();
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
  scheduleViewTopReset();
}

function resetViewScroll(): void {
  const main = getEl('main');
  const targets: Array<Element | null | undefined> = [
    document.scrollingElement,
    document.documentElement,
    document.body,
    main,
  ];
  targets.forEach((target) => {
    if (!target) return;
    target.scrollTop = 0;
    target.scrollLeft = 0;
  });
  window.scrollTo(0, 0);
  main.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'auto' });
}

function scheduleViewTopReset(): void {
  resetViewScroll();
  requestAnimationFrame(() => {
    resetViewScroll();
    setTimeout(resetViewScroll, 0);
    setTimeout(resetViewScroll, 80);
  });
}

function showMobileView(): void {
  const appRoot = document.querySelector('.app') as HTMLElement | null;
  appRoot?.classList.add('mobile-view-active');
}

function showMobileMenu(): void {
  const appRoot = document.querySelector('.app') as HTMLElement | null;
  appRoot?.classList.remove('mobile-view-active');
  resetViewScroll();
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

function applyAppTheme(theme: AppTheme): void {
  document.body.dataset.theme = theme;
  const select = document.getElementById('appThemeSelect') as HTMLSelectElement | null;
  if (select) select.value = theme;
  const toggle = document.getElementById('appThemeToggle') as HTMLButtonElement | null;
  const label = toggle?.querySelector('.theme-toggle-label');
  if (toggle) {
    toggle.setAttribute('aria-label', theme === 'blue-glass' ? 'Ativar tema claro' : 'Ativar tema escuro');
    toggle.title = theme === 'blue-glass' ? 'Tema claro' : 'Tema escuro';
  }
  if (label) label.textContent = theme === 'blue-glass' ? 'Claro' : 'Escuro';
}

function loadAppThemePreference(): void {
  const raw = localStorage.getItem(APP_THEME_KEY);
  applyAppTheme(raw === 'blue-glass' ? 'blue-glass' : 'light');
}

function initAppThemeControl(): void {
  const select = document.getElementById('appThemeSelect') as HTMLSelectElement | null;
  if (!select) return;
  select.addEventListener('change', () => {
    const theme: AppTheme = select.value === 'blue-glass' ? 'blue-glass' : 'light';
    localStorage.setItem(APP_THEME_KEY, theme);
    applyAppTheme(theme);
  });
  const toggle = document.getElementById('appThemeToggle') as HTMLButtonElement | null;
  toggle?.addEventListener('click', () => {
    const current = document.body.dataset.theme === 'blue-glass' ? 'blue-glass' : 'light';
    const next: AppTheme = current === 'blue-glass' ? 'light' : 'blue-glass';
    localStorage.setItem(APP_THEME_KEY, next);
    applyAppTheme(next);
  });
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

function mountSettingsCadastros(): void {
  const section = document.getElementById('settingsCadastros');
  const mount = document.getElementById('settingsCadastrosMount');
  if (!section || !mount || section.parentElement === mount) return;
  section.classList.remove('hidden');
  mount.appendChild(section);
}

function mountSettingsBanks(): void {
  const mount = document.getElementById('settingsBanksMount');
  if (!mount || mount.querySelector('[data-settings-banks]')) return;
  const card = [...document.querySelectorAll<HTMLElement>('#view-banks .card')].find(
    (item) => item.querySelector('h3')?.textContent?.trim() === 'Novo banco'
  );
  if (!card) return;
  card.style.marginBottom = '18px';
  card.dataset.settingsBanks = 'true';
  mount.appendChild(card);
}

function mountSettingsCreditCards(): void {
  const mount = document.getElementById('settingsCreditCardsMount');
  if (!mount || mount.querySelector('[data-settings-credit-cards]')) return;
  const cards = [...document.querySelectorAll<HTMLElement>('#view-creditCards .card')];
  const newCard = cards.find((card) => card.querySelector('h3')?.textContent?.trim() === 'Novo cartao');
  const listCard = cards.find((card) => card.querySelector('#creditCardsList'));
  if (!newCard && !listCard) return;
  const section = document.createElement('div');
  section.className = 'two-col';
  section.style.marginBottom = '18px';
  section.dataset.settingsCreditCards = 'true';
  if (newCard) section.appendChild(newCard);
  if (listCard) {
    listCard.style.marginTop = '0';
    section.appendChild(listCard);
  }
  mount.appendChild(section);
}

function hideCreditCardsDirectPurchaseCard(): void {
  document.querySelectorAll('#view-creditCards h3').forEach((title) => {
    if (title.textContent?.trim() === 'Nova compra') {
      title.closest('.card')?.classList.add('hidden');
    }
  });
}

function hideSettingsMetaDashboardCard(): void {
  document.querySelectorAll('#view-settings h3').forEach((title) => {
    if (title.textContent?.trim() === 'Meta no Dashboard') {
      title.closest('.card')?.classList.add('hidden');
    }
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
  getEl<HTMLInputElement>('txnDate').value = todayIsoLocal();
  getEl<HTMLInputElement>('txnCategory').value = '';
  getEl<HTMLInputElement>('txnMethod').value = DEFAULT_TRANSACTION_METHOD;
  getEl<HTMLTextAreaElement>('txnDescription').value = '';
  getEl<HTMLInputElement>('txnDueDate').value = '';
  getEl<HTMLSelectElement>('txnExpenseKind').value = '';
  getEl<HTMLSelectElement>('txnInstallments').value = '1';
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
    typeSel.value = t.type;
    getEl<HTMLSelectElement>('txnBank').value =
      t.type === 'saida' && t.expenseCardId && state.creditCards.some((card) => card.id === t.expenseCardId)
        ? `card:${t.expenseCardId}`
        : t.bankId && state.banks.some((b) => b.id === t.bankId)
          ? t.type === 'saida'
            ? `bank:${t.bankId}`
            : t.bankId
          : '';
    getEl<HTMLInputElement>('txnAmount').value = formatMoneyInputBR(Number(t.amount));
    getEl<HTMLInputElement>('txnDate').value = t.date;
    getEl<HTMLInputElement>('txnDueDate').value = t.dueDate ?? '';
    getEl<HTMLInputElement>('txnCategory').value = t.category ?? '';
    getEl<HTMLTextAreaElement>('txnDescription').value = t.description ?? '';
    syncTxnFormUI(t.status);
    getEl<HTMLInputElement>('txnMethod').value = t.type === 'entrada' ? DEFAULT_TRANSACTION_METHOD : (t.method ?? '');
    if (t.type === 'saida' && t.expenseKind && isExpenseKind(t.expenseKind)) {
      getEl<HTMLSelectElement>('txnExpenseKind').value = t.expenseCardId ? `card:${t.expenseCardId}` : t.expenseKind;
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

async function saveTransaction(): Promise<void> {
  if (getTxnModalMode() === 'investimento') {
    if (!state.banks.length) {
      toast('Cadastre pelo menos um banco antes de registrar investimentos.', 'error');
      switchView('settings');
      return;
    }
    saveUnifiedInvestment();
    return;
  }
  const id = getEl<HTMLInputElement>('txnId').value.trim();
  const typeRaw = getEl<HTMLSelectElement>('txnType').value;
  const type: TxnType = isTxnType(typeRaw) ? typeRaw : 'entrada';
  if (type === 'saida' && !state.banks.length && !state.creditCards.length) {
    toast('Cadastre pelo menos uma conta ou um cartao antes de lancar despesas.', 'error');
    switchView('settings');
    return;
  }
  const bankSelect = getEl<HTMLSelectElement>('txnBank').value;
  const paymentSource = type === 'saida' ? parseTxnPaymentSource(bankSelect) : { kind: 'bank' as const, id: bankSelect };
  const bankId =
    type === 'entrada' && !state.banks.length
      ? ''
      : type === 'saida' && paymentSource.kind === 'bank'
        ? paymentSource.id
        : bankSelect;
  const amount = parseMoneyBRL(getEl<HTMLInputElement>('txnAmount').value);
  const date = getEl<HTMLInputElement>('txnDate').value;
  const category = getEl<HTMLInputElement>('txnCategory').value.trim();
  const method =
    type === 'entrada'
      ? DEFAULT_TRANSACTION_METHOD
      : paymentSource.kind === 'card'
        ? 'Cartao'
        : DEFAULT_TRANSACTION_METHOD;
  const description = getEl<HTMLTextAreaElement>('txnDescription').value.trim();
  const dueRaw = getEl<HTMLInputElement>('txnDueDate').value.trim();
  const rawInstallments = Number(getEl<HTMLSelectElement>('txnInstallments').value);
  const installments = Number.isFinite(rawInstallments) ? Math.min(120, Math.max(1, Math.round(rawInstallments))) : 1;
  let expenseKind: ExpenseKind | undefined;
  let expenseCardId: string | undefined;
  if (type === 'saida') {
    if (paymentSource.kind === 'card') {
      expenseKind = 'cartao';
      expenseCardId = paymentSource.id;
    } else if (paymentSource.kind === 'bank') {
      expenseKind = 'variavel';
    } else {
    const ek = getEl<HTMLSelectElement>('txnExpenseKind').value;
    if (ek.startsWith('card:')) {
      const cardId = ek.slice(5);
      if (state.creditCards.some((card) => card.id === cardId)) {
        expenseKind = 'cartao';
        expenseCardId = cardId;
      }
    } else {
      expenseKind = isExpenseKind(ek) ? ek : undefined;
    }
    }
  }
  const status = parseTxnStatus(type, getEl<HTMLSelectElement>('txnStatus').value);
  const isCardPurchase = type === 'saida' && expenseKind === 'cartao';
  if (type === 'saida' && paymentSource.kind === 'none') {
    toast('Selecione a conta debitada ou o cartao da despesa.', 'error');
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
  if (!dueRaw && !isCardPurchase) {
    toast(type === 'saida' ? 'Informe a data de pagamento.' : 'Informe a data de recebimento.', 'error');
    return;
  }
  if (type === 'saida' && !id && !(await confirmBehaviorGuard(`${category} ${description} ${method}`, amount, date))) {
    toast('Lancamento pausado. Voce pode revisar antes de salvar.', 'error');
    return;
  }
  if (isCardPurchase && expenseCardId) {
    const purchase: Omit<CreditCardPurchase, 'id'> = {
      cardId: expenseCardId,
      date,
      description: (description || category || 'Compra no cartao').trim().slice(0, 500),
      category: (category || 'Cartao de Credito').trim(),
      amount: Math.round(amount * 100) / 100,
      installments,
    };
    if (creditCardPurchaseDuplicate(purchase)) {
      toast('Essa compra ja existe na fatura do cartao.', 'error');
      return;
    }
    if (id) state.transactions = state.transactions.filter((t) => t.id !== id);
    state.creditCardPurchases.push({ id: uid(), ...purchase });
    renderAll();
    closeTxnModal();
    switchView('creditCards');
    toast(id ? 'Lancamento movido para a fatura do cartao.' : 'Compra registrada na fatura do cartao.', 'success');
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
    ...(type === 'saida' && expenseCardId ? { expenseCardId } : {}),
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

function repeatedTransactionExists(source: Transaction, nextDate: string, nextDueDate: string | undefined): boolean {
  const sourceDesc = (source.description ?? '').trim();
  const sourceCategory = (source.category ?? '').trim();
  return state.transactions.some(
    (t) =>
      t.type === source.type &&
      t.bankId === source.bankId &&
      Number(t.amount ?? 0) === Number(source.amount ?? 0) &&
      (t.category ?? '').trim() === sourceCategory &&
      (t.description ?? '').trim() === sourceDesc &&
      t.date === nextDate &&
      (t.dueDate ?? '') === (nextDueDate ?? '')
  );
}

function repeatPeriodTransactionsToNextMonth(): void {
  const period = cashflowPeriod();
  const source = transactionsInPeriod(period);
  if (!source.length) {
    toast(`Nenhuma receita ou despesa encontrada em ${period.label}.`, 'error');
    return;
  }
  const nextLabelDate = addMonthsIso(period.start, 1);
  const [nextYear, nextMonth] = nextLabelDate.split('-').map(Number);
  const nextLabel = `${DASHBOARD_MONTH_LABELS[nextMonth - 1]} ${nextYear}`;
  if (!confirm(`Repetir ${source.length} receita(s)/despesa(s) de ${period.label} para ${nextLabel}?`)) return;

  const created: Transaction[] = [];
  let skipped = 0;
  for (const t of source) {
    const nextDate = addMonthsIso(t.date, 1);
    const nextDueDate = t.dueDate ? addMonthsIso(t.dueDate, 1) : undefined;
    if (repeatedTransactionExists(t, nextDate, nextDueDate)) {
      skipped += 1;
      continue;
    }
    created.push({
      ...t,
      id: uid(),
      date: nextDate,
      ...(nextDueDate ? { dueDate: nextDueDate } : {}),
      status: t.type === 'entrada' ? 'a_receber' : 'a_vencer',
    });
  }

  if (!created.length) {
    toast('Nada foi criado: os lancamentos do proximo mes ja existem.', 'error');
    return;
  }
  state.transactions.push(...created);
  renderAll();
  toast(`${created.length} lancamento(s) repetido(s) para ${nextLabel}${skipped ? `; ${skipped} ja existia(m).` : '.'}`, 'success');
}

function deleteTransaction(id: string): void {
  if (!confirm('Deseja excluir este lançamento?')) return;
  state.transactions = state.transactions.filter((t) => t.id !== id);
  state.creditCardPayments = state.creditCardPayments.filter((p) => p.transactionId !== id);
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
  getEl<HTMLSelectElement>('editBankAccountType').value = normalizedBankAccountType(bank) || 'Conta corrente';
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
  state.creditCardPayments = state.creditCardPayments.filter((p) => p.bankId !== id);
  state.creditCards = state.creditCards.map((card) => {
    if (card.bankId !== id) return card;
    const { bankId: _bankId, ...rest } = card;
    return rest;
  });
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
        t.type === 'saida' ? expenseKindLabel(t.expenseKind, t.expenseCardId) : '',
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
  migrateCardTransactionsOutOfCashflow();
  loadDashboardPeriodPreference();
  loadCashflowPeriodPreference();
  mountSettingsCadastros();
  mountSettingsBanks();
  mountSettingsCreditCards();
  hideCreditCardsDirectPurchaseCard();
  hideSettingsMetaDashboardCard();
  loadAppThemePreference();
  initSidebarPreference();

  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = (btn as HTMLButtonElement).dataset.view;
      if (isViewId(v)) switchView(v);
    });
  });
  getEl<HTMLButtonElement>('btnBackToMobileMenu').addEventListener('click', showMobileMenu);
  initAppThemeControl();
  getEl<HTMLSelectElement>('dashboardMonth').addEventListener('change', (e) => {
    const next = Number((e.target as HTMLSelectElement).value);
    if (!Number.isInteger(next) || next < 0 || next > 11) return;
    dashboardMonth = next;
    saveDashboardPeriodPreference();
    renderAll();
  });
  getEl<HTMLInputElement>('dashboardYear').addEventListener('change', (e) => {
    const next = Number((e.target as HTMLInputElement).value);
    if (!Number.isInteger(next) || next < 2000 || next > 2100) {
      renderDashboardPeriodControls();
      return;
    }
    dashboardYear = next;
    saveDashboardPeriodPreference();
    renderAll();
  });
  getEl<HTMLSelectElement>('cashflowMonth').addEventListener('change', (e) => {
    const next = Number((e.target as HTMLSelectElement).value);
    if (!Number.isInteger(next) || next < 0 || next > 11) return;
    cashflowMonth = next;
    saveCashflowPeriodPreference();
    renderTransactionsTable();
  });
  getEl<HTMLInputElement>('cashflowYear').addEventListener('change', (e) => {
    const next = Number((e.target as HTMLInputElement).value);
    if (!Number.isInteger(next) || next < 2000 || next > 2100) {
      renderCashflowPeriodControls();
      return;
    }
    cashflowYear = next;
    saveCashflowPeriodPreference();
    renderTransactionsTable();
  });

  getEl<HTMLButtonElement>('btnAddTxnInline').addEventListener('click', () => openTxnModal(null));
  getEl<HTMLButtonElement>('btnRepeatNextMonth').addEventListener('click', repeatPeriodTransactionsToNextMonth);
  getEl<HTMLButtonElement>('btnCreateBank').addEventListener('click', createBank);
  getEl<HTMLButtonElement>('btnCreateCreditCard').addEventListener('click', createCreditCard);
  getEl<HTMLButtonElement>('btnCreateCreditPurchase').addEventListener('click', () => void createCreditPurchase());
  getEl<HTMLButtonElement>('btnPayCreditInvoice').addEventListener('click', payCreditInvoice);
  getEl<HTMLButtonElement>('behaviorGuardCancel').addEventListener('click', () => closeBehaviorGuardModal(false));
  getEl<HTMLButtonElement>('behaviorGuardConfirm').addEventListener('click', () => closeBehaviorGuardModal(true));
  getEl<HTMLSelectElement>('creditPaymentCard').addEventListener('change', refreshCreditPaymentInvoices);
  getEl<HTMLSelectElement>('creditPaymentInvoice').addEventListener('change', syncCreditPaymentAmount);
  ['creditSimCard', 'creditSimDate', 'creditSimAmount', 'creditSimInstallments'].forEach((id) => {
    getEl<HTMLInputElement | HTMLSelectElement>(id).addEventListener('input', renderCreditSimulator);
    getEl<HTMLInputElement | HTMLSelectElement>(id).addEventListener('change', renderCreditSimulator);
  });
  getEl<HTMLButtonElement>('closeTxnModal').addEventListener('click', closeTxnModal);
  getEl<HTMLButtonElement>('saveTxn').addEventListener('click', () => void saveTransaction());
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
  getEl<HTMLButtonElement>('btnAiParse').addEventListener('click', () => {
    const source = getEl<HTMLTextAreaElement>('aiEntryText').value.trim();
    if (!source) {
      toast('Descreva o que aconteceu para o assistente interpretar.', 'error');
      return;
    }
    const normalized = normalizeAssistantText(source);
    if (isAssistantCreditPurchase(normalized)) {
      assistantCreditDraft = buildAssistantCreditDraft(source);
      assistantDraft = null;
    } else {
      assistantDraft = buildAssistantDraft(source);
      assistantCreditDraft = null;
    }
    renderAssistantPreview();
  });
  getEl<HTMLButtonElement>('btnAiClear').addEventListener('click', () => {
    assistantDraft = null;
    assistantCreditDraft = null;
    getEl<HTMLTextAreaElement>('aiEntryText').value = '';
    renderAssistantPreview();
  });
  getEl<HTMLTextAreaElement>('aiEntryText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      getEl<HTMLButtonElement>('btnAiParse').click();
    }
  });
  getEl('aiEntryPreview').addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('#btnAiSave')) void saveAssistantDraft();
    if (target.closest('#btnAiCreditSave')) void saveAssistantCreditDraft();
    if (target.closest('#btnAiDiscard')) {
      assistantDraft = null;
      assistantCreditDraft = null;
      renderAssistantPreview();
    }
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
  getEl<HTMLSelectElement>('txnBank').addEventListener('change', updateTxnPaymentSourceUI);
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
  getEl('behaviorHabitList').addEventListener('change', (e) => {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLInputElement && t.matches('input[data-behavior-limit]')) persistBehaviorLimitFromInput(t);
  });
  getEl('behaviorHabitList').addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (e.key === 'Enter' && t instanceof HTMLInputElement && t.matches('input[data-behavior-limit]')) {
      e.preventDefault();
      persistBehaviorLimitFromInput(t);
      t.blur();
    }
  });
  getEl('creditCardsList').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-delete-credit-card]');
    const id = btn?.getAttribute('data-delete-credit-card');
    if (id) deleteCreditCard(id);
  });
  getEl('creditInvoicesTable').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-delete-credit-purchase]');
    const id = btn?.getAttribute('data-delete-credit-purchase');
    if (id) deleteCreditPurchase(id);
  });
  getEl<HTMLInputElement>('cadInvTypeInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addCatalogInvType();
    }
  });
  getEl('settingsCadastros').addEventListener('click', (e) => {
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
  getEl('transactionsTable').addEventListener('change', (e) => {
    const sel = (e.target as HTMLElement).closest('[data-txn-status]') as HTMLSelectElement | null;
    if (!sel) return;
    const id = sel.getAttribute('data-txn-status');
    const txn = state.transactions.find((t) => t.id === id);
    if (!txn) return;
    const next = parseTxnStatus(txn.type, sel.value);
    if (!next) {
      renderTransactionsTable();
      return;
    }
    txn.status = next;
    renderAll();
    toast(
      txn.type === 'saida' && next === 'pago'
        ? 'Despesa marcada como paga e abatida da conta.'
        : txn.type === 'entrada' && next === 'recebido'
          ? 'Receita marcada como recebida e somada na conta.'
          : 'Status atualizado.',
      'success'
    );
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
    if (t.id === 'behaviorGuardModal') closeBehaviorGuardModal(false);
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeTxnModal();
      closeBankModal();
      closeInvModal();
      if (document.getElementById('behaviorGuardModal')?.classList.contains('open')) closeBehaviorGuardModal(false);
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
