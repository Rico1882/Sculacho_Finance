export type TxnType = 'entrada' | 'saida';

export type ExpenseKind = 'fixa' | 'variavel';

export type IncomeTxnStatus = 'recebido' | 'a_receber' | 'em_atraso';
export type ExpenseTxnStatus = 'pago' | 'a_vencer' | 'em_atraso' | 'agendado';
export type TxnStatus = IncomeTxnStatus | ExpenseTxnStatus;

export interface Bank {
  id: string;
  name: string;
  accountType: string;
  note: string;
  code?: string;
  segment?: string;
}

export interface Transaction {
  id: string;
  /** Conta: em despesas a debitada; em receitas a creditada (vazio se não aplicável ou legado). */
  bankId: string;
  type: TxnType;
  amount: number;
  date: string;
  category: string;
  method: string;
  description: string;
  dueDate?: string;
  expenseKind?: ExpenseKind;
  status?: TxnStatus;
}

/** Listas para classificar lançamentos e investimentos (estilo planilha “Cadastros”). */
export interface AppCatalog {
  incomeCategories: string[];
  expenseCategories: string[];
  investmentTypes: string[];
}

export const SAVINGS_GOAL_IDS = ['carro', 'casa', 'apartamento', 'celular', 'consorcio'] as const;
export type SavingsGoalId = (typeof SAVINGS_GOAL_IDS)[number];

export interface Investment {
  id: string;
  date: string;
  type: string;
  institution: string;
  amount: number;
  /** Conta onde o aporte foi registrado (unifica com o modal de lançamento). */
  bankId?: string;
  /** Se definido, o valor do aporte entra no total «já separado» dessa meta (com o manual). */
  savingsGoalId?: SavingsGoalId;
  monthlyYieldPct?: number;
  months?: number;
  notes?: string;
}

export interface SavingsGoalEntry {
  /** Valor alvo da compra / objetivo. */
  target: number;
  /** Valor manual extra; na barra soma-se ainda os aportes com esta meta no lançamento de investimento. */
  saved: number;
}

export interface AppState {
  banks: Bank[];
  transactions: Transaction[];
  investments: Investment[];
  catalog: AppCatalog;
  /** Legado: importação preserva o valor; a UI usa apenas annualInvestmentGoal para a meta no Dashboard. */
  annualPatrimonyGoal: number;
  /** Meta em R$ de aportes em investimentos no ano civil corrente (aba Investimentos). */
  annualInvestmentGoal: number;
  /** Metas de compra (carro, casa, etc.): alvo e valor já separado. */
  savingsGoals: Record<SavingsGoalId, SavingsGoalEntry>;
  /** Limites mensais por categoria de despesa. */
  monthlyBudgets: Record<string, number>;
}

export const VIEWS = [
  'dashboard',
  'transactions',
  'budgets',
  'banks',
  'cadastros',
  'investments',
  'reports',
  'settings',
] as const;
export type ViewId = (typeof VIEWS)[number];

export function isViewId(value: string | undefined): value is ViewId {
  return value !== undefined && (VIEWS as readonly string[]).includes(value);
}

export function isTxnType(value: string): value is TxnType {
  return value === 'entrada' || value === 'saida';
}

export function isExpenseKind(value: string): value is ExpenseKind {
  return value === 'fixa' || value === 'variavel';
}

export function isSavingsGoalId(value: string | undefined): value is SavingsGoalId {
  return value !== undefined && (SAVINGS_GOAL_IDS as readonly string[]).includes(value);
}
