import { Injectable, signal, Component, inject, computed, effect, ViewChild, ElementRef, AfterViewInit, OnDestroy, ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged, User } from 'firebase/auth';
import { getFirestore, collection, doc, setDoc, getDoc, query, where, orderBy, onSnapshot, deleteDoc, addDoc, QuerySnapshot, DocumentData } from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';
import { GoogleGenAI } from '@google/genai';
import { Router, RouterLink, RouterOutlet, RouterLinkActive, provideRouter, Routes, CanActivateFn } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { DatePipe, CurrencyPipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import Chart from 'chart.js/auto';
import { bootstrapApplication } from '@angular/platform-browser';


const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

export interface Expense {
  id?: string;
  uid: string;
  amount: number;
  category: string;
  date: string;
  vendor: string;
  note?: string;
  source: 'manual' | 'scan';
  createdAt: string;
}

export interface Budget {
  id?: string;
  uid: string;
  month: string;
  limits: Record<string, number>;
  updatedAt: string;
}

export interface Insight {
  id?: string;
  uid: string;
  month: string;
  tips: { problem: string; savingAmount: number; actionStep: string; explanation?: string }[];
  createdAt: string;
}

@Injectable({ providedIn: 'root' })
export class FirebaseService {
  user = signal<User | null>(null);
  isAuthReady = signal(false);
  
  expenses = signal<Expense[]>([]);
  budgets = signal<Budget | null>(null);
  insights = signal<Insight | null>(null);

  private unsubExpenses: (() => void) | null = null;
  private unsubBudgets: (() => void) | null = null;
  private unsubInsights: (() => void) | null = null;

  constructor() {
    onAuthStateChanged(auth, (user: User | null) => {
      this.user.set(user);
      this.isAuthReady.set(true);
      if (user) {
        this.ensureUserProfile(user);
        this.listenToExpenses(user.uid);
        this.listenToBudgets(user.uid);
        this.listenToInsights(user.uid);
      } else {
        if (this.unsubExpenses) this.unsubExpenses();
        if (this.unsubBudgets) this.unsubBudgets();
        if (this.unsubInsights) this.unsubInsights();
        this.expenses.set([]);
        this.budgets.set(null);
        this.insights.set(null);
      }
    });
  }

  async loginWithGoogle() {
    const provider = new GoogleAuthProvider();
    await signInWithPopup(auth, provider);
  }

  async logout() {
    await signOut(auth);
  }

  private async ensureUserProfile(user: User) {
    const userRef = doc(db, 'users', user.uid);
    const snap = await getDoc(userRef);
    if (!snap.exists()) {
      await setDoc(userRef, {
        uid: user.uid,
        email: user.email || 'no-email@example.com',
        currency: 'USD',
        createdAt: new Date().toISOString()
      });
    }
  }

  private listenToExpenses(uid: string) {
    const q = query(collection(db, 'users', uid, 'expenses'), orderBy('date', 'desc'));
    this.unsubExpenses = onSnapshot(q, (snap: QuerySnapshot<DocumentData, DocumentData>) => {
      const exps = snap.docs.map((d: any) => ({ id: d.id, ...d.data() } as Expense));
      this.expenses.set(exps);
    }, (error) => {
      console.error('Firestore Error in expenses listener:', error);
    });
  }

  private listenToBudgets(uid: string) {
    const q = query(collection(db, 'users', uid, 'budgets'), where('month', '==', 'default'));
    this.unsubBudgets = onSnapshot(q, (snap: QuerySnapshot<DocumentData, DocumentData>) => {
      if (!snap.empty) {
        this.budgets.set({ id: snap.docs[0].id, ...snap.docs[0].data() } as Budget);
      } else {
        this.budgets.set(null);
      }
    }, (error) => {
      console.error('Firestore Error in budgets listener:', error);
    });
  }

  private listenToInsights(uid: string) {
    const q = query(collection(db, 'users', uid, 'insights'), where('month', '==', 'default'));
    this.unsubInsights = onSnapshot(q, (snap: QuerySnapshot<DocumentData, DocumentData>) => {
      if (!snap.empty) {
        this.insights.set({ id: snap.docs[0].id, ...snap.docs[0].data() } as Insight);
      } else {
        this.insights.set(null);
      }
    }, (error) => {
      console.error('Firestore Error in insights listener:', error);
    });
  }

  async addExpense(expense: Omit<Expense, 'id' | 'uid' | 'createdAt'>) {
    const uid = this.user()?.uid;
    if (!uid) throw new Error('Not authenticated');
    
    const newExpense: Expense = {
      ...expense,
      uid,
      createdAt: new Date().toISOString()
    };
    
    await addDoc(collection(db, 'users', uid, 'expenses'), newExpense);
  }

  async deleteExpense(expenseId: string) {
    const uid = this.user()?.uid;
    if (!uid) throw new Error('Not authenticated');
    await deleteDoc(doc(db, 'users', uid, 'expenses', expenseId));
  }

  async saveBudget(month: string, limits: Record<string, number>) {
    const uid = this.user()?.uid;
    if (!uid) throw new Error('Not authenticated');
    
    const budgetId = month;
    const budgetRef = doc(db, 'users', uid, 'budgets', budgetId);
    
    await setDoc(budgetRef, {
      uid,
      month,
      limits,
      updatedAt: new Date().toISOString()
    });
  }

  async saveInsight(month: string, tips: Insight['tips']) {
    const uid = this.user()?.uid;
    if (!uid) throw new Error('Not authenticated');
    
    const insightId = month;
    const insightRef = doc(db, 'users', uid, 'insights', insightId);
    
    await setDoc(insightRef, {
      uid,
      month,
      tips,
      createdAt: new Date().toISOString()
    });
  }
}


@Injectable({ providedIn: 'root' })
export class GeminiService {
  private ai: GoogleGenAI;

  constructor() {
    this.ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  }

  async extractReceiptData(base64Image: string, mimeType: string) {
    const prompt = `From this receipt/bill text, extract: 
1) Total amount (number only)
2) Date (YYYY-MM-DD)
3) Vendor/shop name
4) Best category from: [Food, Transport, Utilities, Health, Shopping, Entertainment, Other]

Return as JSON only: {"amount": number, "date": "string", "vendor": "string", "category": "string"}`;

    const response = await this.ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            {
              inlineData: {
                data: base64Image,
                mimeType: mimeType
              }
            }
          ]
        }
      ],
      config: {
        responseMimeType: 'application/json',
      }
    });

    if (!response.text) throw new Error('Failed to extract receipt data');
    return JSON.parse(response.text);
  }

  async generateInsights(expenses: {amount: number, category: string}[]) {
    const expensesJson = JSON.stringify(expenses);
    const prompt = `Analyze these expenses: ${expensesJson}
    
Group expenses by category. Calculate percentage of total per category.
Compare against benchmark averages:
- Food (home): max 15% of income
- Food delivery/eating out: max 10%
- Transport: max 15%
- Entertainment: max 5%
- Shopping: max 10%

Flag categories exceeding benchmark.
Generate 3-5 specific, actionable money-saving tips.
For each tip: problem identified + exact saving amount + action step + explanation.
Return as JSON only:
{
  "tips": [
    {
      "problem": "string",
      "savingAmount": number,
      "actionStep": "string",
      "explanation": "string"
    }
  ]
}`;

    const response = await this.ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
      }
    });

    if (!response.text) throw new Error('Failed to generate insights');
    return JSON.parse(response.text);
  }
}


@Component({
  selector: 'app-onboarding',
  standalone: true,
  imports: [MatIconModule],
  template: `
    <div class="min-h-screen bg-slate-950 text-slate-50 flex flex-col items-center justify-center p-6">
      <div class="max-w-md w-full space-y-12 text-center">
        
        <div class="space-y-4">
          <div class="w-20 h-20 bg-emerald-500/20 text-emerald-400 rounded-2xl flex items-center justify-center mx-auto mb-8">
            <mat-icon class="text-4xl w-10 h-10">account_balance_wallet</mat-icon>
          </div>
          <h1 class="text-4xl font-semibold tracking-tight">SpendWise</h1>
          <p class="text-slate-400 text-lg">Smart Expense AI</p>
        </div>

        <div class="space-y-8 text-left bg-slate-900/50 p-6 rounded-3xl border border-slate-800">
          <div class="flex items-start gap-4">
            <div class="w-10 h-10 rounded-full bg-blue-500/20 text-blue-400 flex items-center justify-center shrink-0">
              <mat-icon>track_changes</mat-icon>
            </div>
            <div>
              <h3 class="font-medium text-lg">Track every dollar</h3>
              <p class="text-slate-400 text-sm mt-1">Keep a close eye on your daily expenses with ease.</p>
            </div>
          </div>
          
          <div class="flex items-start gap-4">
            <div class="w-10 h-10 rounded-full bg-purple-500/20 text-purple-400 flex items-center justify-center shrink-0">
              <mat-icon>document_scanner</mat-icon>
            </div>
            <div>
              <h3 class="font-medium text-lg">Scan any bill in 2 seconds</h3>
              <p class="text-slate-400 text-sm mt-1">Use AI to automatically extract data from your receipts.</p>
            </div>
          </div>

          <div class="flex items-start gap-4">
            <div class="w-10 h-10 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0">
              <mat-icon>lightbulb</mat-icon>
            </div>
            <div>
              <h3 class="font-medium text-lg">AI tells you where to save</h3>
              <p class="text-slate-400 text-sm mt-1">Get personalized advice based on your spending habits.</p>
            </div>
          </div>
        </div>

        <button 
          (click)="login()" 
          class="w-full bg-emerald-500 hover:bg-emerald-600 text-white font-medium py-4 rounded-2xl transition-colors flex items-center justify-center gap-2">
          <mat-icon>login</mat-icon>
          Get Started Free
        </button>
      </div>
    </div>
  `
})
export class OnboardingComponent {
  private firebase = inject(FirebaseService);
  private router = inject(Router);

  async login() {
    try {
      await this.firebase.loginWithGoogle();
      this.router.navigate(['/dashboard']);
    } catch (e) {
      console.error('Login failed', e);
    }
  }
}


@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [RouterLink, MatIconModule, DatePipe, CurrencyPipe],
  template: `
    <div class="pb-24">
      <header class="p-6 flex justify-between items-center">
        <div>
          <p class="text-slate-400 text-sm">Total Spent</p>
          <h1 class="text-4xl font-semibold tracking-tight text-slate-50 mt-1">
            {{ totalSpent() | currency:'USD' }}
          </h1>
        </div>
        <a routerLink="/profile" class="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center text-slate-300">
          <mat-icon>person</mat-icon>
        </a>
      </header>

      @if (latestInsight()) {
        <div class="px-6 mb-8">
          <div class="bg-gradient-to-br from-emerald-900/40 to-slate-900 border border-emerald-500/20 p-5 rounded-3xl">
            <div class="flex items-center gap-2 text-emerald-400 mb-2">
              <mat-icon class="text-sm w-5 h-5">auto_awesome</mat-icon>
              <span class="text-sm font-medium">AI Insight</span>
            </div>
            <p class="text-slate-200 text-sm leading-relaxed">{{ latestInsight()?.actionStep }}</p>
            <a routerLink="/insights" class="text-emerald-400 text-xs font-medium mt-3 inline-block">View all insights &rarr;</a>
          </div>
        </div>
      }

      <div class="px-6 mb-8">
        <div class="flex justify-between items-end mb-3">
          <h2 class="text-lg font-medium text-slate-50">Budget</h2>
          <a routerLink="/budget" class="text-sm text-emerald-400">Manage</a>
        </div>
        <div class="bg-slate-900 p-5 rounded-3xl border border-slate-800">
          <div class="flex justify-between text-sm mb-2">
            <span class="text-slate-400">Spent</span>
            <span class="text-slate-50 font-medium">{{ totalSpent() | currency:'USD' }} / {{ totalBudget() | currency:'USD' }}</span>
          </div>
          <div class="h-2 bg-slate-800 rounded-full overflow-hidden">
            <div class="h-full bg-emerald-500 rounded-full" [style.width.%]="budgetPercentage()"></div>
          </div>
        </div>
      </div>

      <div class="px-6">
        <div class="flex justify-between items-end mb-4">
          <h2 class="text-lg font-medium text-slate-50">Recent Transactions</h2>
          <a routerLink="/list" class="text-sm text-emerald-400">See all</a>
        </div>
        
        <div class="space-y-3">
          @for (expense of recentExpenses(); track expense.id) {
            <div class="bg-slate-900 p-4 rounded-2xl border border-slate-800 flex items-center justify-between">
              <div class="flex items-center gap-4">
                <div class="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center text-slate-400">
                  <mat-icon>{{ getCategoryIcon(expense.category) }}</mat-icon>
                </div>
                <div>
                  <p class="font-medium text-slate-50">{{ expense.vendor || expense.category }}</p>
                  <p class="text-xs text-slate-400">{{ expense.date | date:'MMM d' }} &bull; {{ expense.category }}</p>
                </div>
              </div>
              <p class="font-medium text-slate-50">{{ expense.amount | currency:'USD' }}</p>
            </div>
          } @empty {
            <div class="text-center py-8 text-slate-500">
              <mat-icon class="text-4xl mb-2 opacity-50">receipt_long</mat-icon>
              <p>No expenses yet.</p>
            </div>
          }
        </div>
      </div>
    </div>
  `
})
export class DashboardComponent {
  firebase = inject(FirebaseService);

  expenses = this.firebase.expenses;
  budgets = this.firebase.budgets;
  insights = this.firebase.insights;

  recentExpenses = computed(() => this.expenses().slice(0, 5));
  
  totalSpent = computed(() => {
    return this.expenses()
      .reduce((sum, e) => sum + Number(e.amount || 0), 0);
  });

  totalBudget = computed(() => {
    const b = this.budgets();
    if (!b) return 0;
    return Object.values(b.limits).reduce((sum, limit) => sum + limit, 0);
  });

  budgetPercentage = computed(() => {
    const spent = this.totalSpent();
    const budget = this.totalBudget();
    if (budget === 0) return 0;
    return Math.min(100, (spent / budget) * 100);
  });

  latestInsight = computed(() => {
    const ins = this.insights();
    if (!ins || !ins.tips || ins.tips.length === 0) return null;
    return ins.tips[0];
  });

  getCategoryIcon(category: string): string {
    const icons: Record<string, string> = {
      'Food': 'restaurant',
      'Transport': 'directions_car',
      'Rent': 'home',
      'Utilities': 'bolt',
      'Health': 'favorite',
      'Shopping': 'shopping_bag',
      'Entertainment': 'movie',
      'Other': 'more_horiz'
    };
    return icons[category] || 'receipt';
  }
}


@Component({
  selector: 'app-add-expense',
  standalone: true,
  imports: [MatIconModule, FormsModule, RouterLink],
  template: `
    <div class="min-h-screen bg-slate-950 text-slate-50 flex flex-col">
      <header class="p-4 flex items-center justify-between border-b border-slate-800">
        <button (click)="goBack()" class="w-10 h-10 flex items-center justify-center text-slate-400 hover:text-slate-200">
          <mat-icon>close</mat-icon>
        </button>
        <h1 class="text-lg font-medium">Add Expense</h1>
        <div class="w-10"></div>
      </header>

      <div class="flex-1 overflow-y-auto p-6">
        <div class="mb-8 text-center">
          <p class="text-slate-400 mb-2">Amount</p>
          <div class="flex items-center justify-center text-5xl font-semibold">
            <span class="text-slate-500 mr-1">$</span>
            <input 
              type="number" 
              [(ngModel)]="amount" 
              class="bg-transparent border-none outline-none text-center w-full max-w-[200px] placeholder-slate-700"
              placeholder="0.00"
              step="0.01"
            >
          </div>
        </div>

        <div class="space-y-6">
          <button routerLink="/scan" class="w-full bg-slate-900 border border-emerald-500/30 text-emerald-400 py-4 rounded-2xl flex items-center justify-center gap-2 hover:bg-slate-800 transition-colors">
            <mat-icon>document_scanner</mat-icon>
            Scan Receipt with AI
          </button>

          <div>
            <span class="block text-sm text-slate-400 mb-3">Category</span>
            <div class="grid grid-cols-4 gap-3">
              @for (cat of categories; track cat.name) {
                <button 
                  (click)="category.set(cat.name)"
                  [class.bg-emerald-500]="category() === cat.name"
                  [class.text-slate-950]="category() === cat.name"
                  [class.bg-slate-900]="category() !== cat.name"
                  [class.text-slate-400]="category() !== cat.name"
                  class="flex flex-col items-center justify-center p-3 rounded-2xl border border-slate-800 transition-colors">
                  <mat-icon class="mb-1">{{ cat.icon }}</mat-icon>
                  <span class="text-[10px] font-medium">{{ cat.name }}</span>
                </button>
              }
            </div>
          </div>

          <div class="space-y-4">
            <div>
              <span class="block text-sm text-slate-400 mb-1">Vendor</span>
              <input type="text" [(ngModel)]="vendor" class="w-full bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 text-slate-50 outline-none focus:border-emerald-500 transition-colors" placeholder="e.g. Starbucks">
            </div>
            
            <div>
              <span class="block text-sm text-slate-400 mb-1">Date</span>
              <input type="date" [(ngModel)]="date" class="w-full bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 text-slate-50 outline-none focus:border-emerald-500 transition-colors [color-scheme:dark]">
            </div>

            <div>
              <span class="block text-sm text-slate-400 mb-1">Note (Optional)</span>
              <input type="text" [(ngModel)]="note" class="w-full bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 text-slate-50 outline-none focus:border-emerald-500 transition-colors" placeholder="Add a note">
            </div>
          </div>
        </div>
      </div>

      <div class="p-6 border-t border-slate-800 bg-slate-950">
        <button 
          (click)="save()" 
          [disabled]="!isValid() || isSaving()"
          class="w-full bg-emerald-500 hover:bg-emerald-600 disabled:bg-slate-800 disabled:text-slate-500 text-slate-950 font-medium py-4 rounded-2xl transition-colors flex items-center justify-center gap-2">
          @if (isSaving()) {
            <mat-icon class="animate-spin">refresh</mat-icon>
            Saving...
          } @else {
            Save Expense
          }
        </button>
      </div>
    </div>
  `
})
export class AddExpenseComponent {
  private firebase = inject(FirebaseService);
  private router = inject(Router);

  amount = signal<number | null>(null);
  category = signal<string>('Other');
  vendor = signal<string>('');
  date = signal<string>(new Date().toISOString().split('T')[0]);
  note = signal<string>('');
  source = signal<'manual' | 'scan'>('manual');
  
  isSaving = signal(false);

  categories = [
    { name: 'Food', icon: 'restaurant' },
    { name: 'Transport', icon: 'directions_car' },
    { name: 'Rent', icon: 'home' },
    { name: 'Utilities', icon: 'bolt' },
    { name: 'Health', icon: 'favorite' },
    { name: 'Shopping', icon: 'shopping_bag' },
    { name: 'Entertainment', icon: 'movie' },
    { name: 'Other', icon: 'more_horiz' }
  ];

  constructor() {
    const nav = this.router.getCurrentNavigation();
    if (nav?.extras.state?.['scannedData']) {
      const data = nav.extras.state['scannedData'];
      if (data.amount) this.amount.set(data.amount);
      if (data.category && this.categories.some(c => c.name === data.category)) this.category.set(data.category);
      if (data.vendor) this.vendor.set(data.vendor);
      if (data.date) this.date.set(data.date);
      this.source.set('scan');
    }
  }

  goBack() {
    this.router.navigate(['/dashboard']);
  }

  isValid() {
    return this.amount() && this.amount()! > 0 && this.category() && this.vendor() && this.date();
  }

  async save() {
    if (!this.isValid()) return;
    this.isSaving.set(true);
    try {
      let parsedDate = this.date();
      const d = new Date(parsedDate);
      if (!isNaN(d.getTime())) {
        parsedDate = d.toISOString().split('T')[0];
      }

      await this.firebase.addExpense({
        amount: Number(this.amount()!),
        category: this.category(),
        vendor: this.vendor(),
        date: parsedDate,
        note: this.note(),
        source: this.source()
      });
      this.router.navigate(['/dashboard']);
    } catch (e) {
      console.error('Failed to save', e);
      alert('Failed to save expense');
    } finally {
      this.isSaving.set(false);
    }
  }
}


@Component({
  selector: 'app-scanner',
  standalone: true,
  imports: [MatIconModule],
  template: `
    <div class="min-h-screen bg-black text-white flex flex-col relative">
      <header class="absolute top-0 left-0 right-0 p-4 flex items-center justify-between z-20 bg-gradient-to-b from-black/80 to-transparent">
        <button (click)="goBack()" class="w-10 h-10 flex items-center justify-center text-white bg-black/40 rounded-full backdrop-blur-md">
          <mat-icon>close</mat-icon>
        </button>
        <h1 class="text-sm font-medium tracking-wider uppercase">Scan Receipt</h1>
        <div class="w-10"></div>
      </header>

      <div class="flex-1 relative overflow-hidden bg-slate-900 flex items-center justify-center">
        <video #videoElement autoplay playsinline class="absolute inset-0 w-full h-full object-cover"></video>
        
        <div class="absolute inset-0 pointer-events-none border-[40px] border-black/60"></div>
        <div class="absolute inset-0 pointer-events-none flex items-center justify-center">
          <div class="w-64 h-96 border-2 border-emerald-500 rounded-xl relative">
            <div class="absolute -top-1 -left-1 w-4 h-4 border-t-4 border-l-4 border-emerald-500 rounded-tl-lg"></div>
            <div class="absolute -top-1 -right-1 w-4 h-4 border-t-4 border-r-4 border-emerald-500 rounded-tr-lg"></div>
            <div class="absolute -bottom-1 -left-1 w-4 h-4 border-b-4 border-l-4 border-emerald-500 rounded-bl-lg"></div>
            <div class="absolute -bottom-1 -right-1 w-4 h-4 border-b-4 border-r-4 border-emerald-500 rounded-br-lg"></div>
          </div>
        </div>

        @if (isProcessing()) {
          <div class="absolute inset-0 bg-black/80 backdrop-blur-sm flex flex-col items-center justify-center z-30">
            <mat-icon class="animate-spin text-emerald-500 text-5xl w-12 h-12 mb-4">refresh</mat-icon>
            <p class="text-emerald-400 font-medium animate-pulse">Extracting data with AI...</p>
          </div>
        }
      </div>

      <div class="p-8 pb-safe bg-black flex flex-col items-center justify-center relative z-20">
        <p class="text-slate-400 text-sm mb-6 text-center">Point at any bill or receipt</p>
        <div class="flex items-center gap-8">
          <button 
            (click)="fileInput.click()"
            [disabled]="isProcessing()"
            class="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center text-slate-300 hover:bg-slate-700 transition-colors">
            <mat-icon>image</mat-icon>
          </button>
          
          <button 
            (click)="capture()" 
            [disabled]="isProcessing()"
            class="w-20 h-20 rounded-full border-4 border-emerald-500 flex items-center justify-center p-1 active:scale-95 transition-transform">
            <div class="w-full h-full bg-white rounded-full"></div>
          </button>
          
          <div class="w-12"></div> <!-- Spacer for centering -->
        </div>
        <input type="file" #fileInput accept="image/*" class="hidden" (change)="onFileSelected($event)">
      </div>

      <canvas #canvasElement class="hidden"></canvas>
    </div>
  `,
  styles: [`
    .pb-safe { padding-bottom: env(safe-area-inset-bottom, 2rem); }
  `]
})
export class ScannerComponent implements AfterViewInit, OnDestroy {
  @ViewChild('videoElement') videoElement!: ElementRef<HTMLVideoElement>;
  @ViewChild('canvasElement') canvasElement!: ElementRef<HTMLCanvasElement>;

  @ViewChild('fileInput') fileInput!: ElementRef<HTMLInputElement>;

  private router = inject(Router);
  private gemini = inject(GeminiService);
  private stream: MediaStream | null = null;

  isProcessing = signal(false);

  ngAfterViewInit() {
    this.startCamera();
  }

  ngOnDestroy() {
    this.stopCamera();
  }

  async startCamera() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: 'environment' } 
      });
      this.videoElement.nativeElement.srcObject = this.stream;
    } catch (err) {
      console.warn('Environment camera failed, trying default camera', err);
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ 
          video: true 
        });
        this.videoElement.nativeElement.srcObject = this.stream;
      } catch {
        console.warn('Camera access denied or unavailable. User can use file upload fallback.');
      }
    }
  }

  stopCamera() {
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
    }
  }

  goBack() {
    this.router.navigate(['/add']);
  }

  async capture() {
    if (this.isProcessing()) return;
    
    if (!this.stream) {
      // If camera is not active, trigger file upload instead
      this.fileInput.nativeElement.click();
      return;
    }

    const video = this.videoElement.nativeElement;
    const canvas = this.canvasElement.nativeElement;
    
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    ctx.drawImage(video, 0, 0);
    const base64Image = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
    
    this.processImage(base64Image, 'image/jpeg');
  }

  onFileSelected(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const result = e.target?.result as string;
      const base64Image = result.split(',')[1];
      const mimeType = file.type;
      this.processImage(base64Image, mimeType);
    };
    reader.readAsDataURL(file);
  }

  async processImage(base64Image: string, mimeType: string) {
    this.isProcessing.set(true);
    try {
      const extractedData = await this.gemini.extractReceiptData(base64Image, mimeType);
      this.stopCamera();
      this.router.navigate(['/add'], { state: { scannedData: extractedData } });
    } catch (e) {
      console.error('OCR failed', e);
      alert('Failed to extract data. Please try again.');
      this.isProcessing.set(false);
    }
  }
}


@Component({
  selector: 'app-expense-list',
  standalone: true,
  imports: [MatIconModule, DatePipe, CurrencyPipe, FormsModule],
  template: `
    <div class="pb-24 min-h-screen flex flex-col">
      <header class="p-6 pb-4 bg-slate-950 sticky top-0 z-10 border-b border-slate-900">
        <h1 class="text-2xl font-semibold text-slate-50 mb-4">Transactions</h1>
        
        <div class="flex gap-2">
          <div class="relative flex-1">
            <mat-icon class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 w-5 h-5 text-sm">search</mat-icon>
            <input 
              type="text" 
              [(ngModel)]="searchQuery"
              placeholder="Search vendor or note..." 
              class="w-full bg-slate-900 border border-slate-800 rounded-xl pl-10 pr-4 py-2.5 text-sm text-slate-50 outline-none focus:border-emerald-500 transition-colors"
            >
          </div>
          <select 
            [(ngModel)]="selectedCategory"
            class="bg-slate-900 border border-slate-800 rounded-xl px-3 py-2.5 text-sm text-slate-50 outline-none focus:border-emerald-500 transition-colors">
            <option value="">All</option>
            <option value="Food">Food</option>
            <option value="Transport">Transport</option>
            <option value="Rent">Rent</option>
            <option value="Utilities">Utilities</option>
            <option value="Health">Health</option>
            <option value="Shopping">Shopping</option>
            <option value="Entertainment">Entertainment</option>
            <option value="Other">Other</option>
          </select>
        </div>
      </header>

      <div class="flex-1 p-6 space-y-3">
        @for (expense of filteredExpenses(); track expense.id) {
          <div class="bg-slate-900 p-4 rounded-2xl border border-slate-800 flex items-center justify-between group">
            <div class="flex items-center gap-4">
              <div class="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center text-slate-400">
                <mat-icon>{{ getCategoryIcon(expense.category) }}</mat-icon>
              </div>
              <div>
                <p class="font-medium text-slate-50">{{ expense.vendor || expense.category }}</p>
                <div class="flex items-center gap-2 text-xs text-slate-400">
                  <span>{{ expense.date | date:'MMM d, yyyy' }}</span>
                  <span>&bull;</span>
                  <span>{{ expense.category }}</span>
                  @if (expense.source === 'scan') {
                    <mat-icon class="text-[10px] w-3 h-3 text-emerald-500">document_scanner</mat-icon>
                  }
                </div>
              </div>
            </div>
            <div class="flex items-center gap-3">
              <p class="font-medium text-slate-50">{{ expense.amount | currency:'USD' }}</p>
              <button (click)="deleteExpense(expense.id!)" class="text-red-400 opacity-0 group-hover:opacity-100 transition-opacity p-1">
                <mat-icon class="text-sm w-5 h-5">delete</mat-icon>
              </button>
            </div>
          </div>
        } @empty {
          <div class="text-center py-12 text-slate-500">
            <mat-icon class="text-5xl mb-3 opacity-50">search_off</mat-icon>
            <p>No transactions found.</p>
          </div>
        }
      </div>
    </div>
  `
})
export class ExpenseListComponent {
  private firebase = inject(FirebaseService);
  
  searchQuery = signal('');
  selectedCategory = signal('');

  filteredExpenses = computed(() => {
    let exps = this.firebase.expenses();
    const q = this.searchQuery().toLowerCase();
    const cat = this.selectedCategory();

    if (q) {
      exps = exps.filter(e => 
        e.vendor.toLowerCase().includes(q) || 
        (e.note && e.note.toLowerCase().includes(q))
      );
    }
    if (cat) {
      exps = exps.filter(e => e.category === cat);
    }
    return exps;
  });

  getCategoryIcon(category: string): string {
    const icons: Record<string, string> = {
      'Food': 'restaurant',
      'Transport': 'directions_car',
      'Rent': 'home',
      'Utilities': 'bolt',
      'Health': 'favorite',
      'Shopping': 'shopping_bag',
      'Entertainment': 'movie',
      'Other': 'more_horiz'
    };
    return icons[category] || 'receipt';
  }

  async deleteExpense(id: string) {
    try {
      await this.firebase.deleteExpense(id);
    } catch (e) {
      console.error('Failed to delete expense', e);
    }
  }
}


@Component({
  selector: 'app-insights',
  standalone: true,
  imports: [MatIconModule, CurrencyPipe],
  template: `
    <div class="pb-24 min-h-screen flex flex-col">
      <header class="p-6 pb-4 bg-slate-950 sticky top-0 z-10 border-b border-slate-900">
        <h1 class="text-2xl font-semibold text-slate-50 mb-1">AI Insights</h1>
        <p class="text-slate-400 text-sm">Personalized advice to help you save</p>
      </header>

      <div class="flex-1 p-6">
        @if (isGenerating()) {
          <div class="flex flex-col items-center justify-center py-12 text-center">
            <div class="w-16 h-16 bg-emerald-500/20 text-emerald-400 rounded-2xl flex items-center justify-center mb-4 animate-pulse">
              <mat-icon class="text-3xl w-8 h-8 animate-spin">auto_awesome</mat-icon>
            </div>
            <h3 class="text-lg font-medium text-slate-50 mb-2">Analyzing your spending...</h3>
            <p class="text-slate-400 text-sm max-w-[250px]">Gemini is reviewing your transactions to find saving opportunities.</p>
          </div>
        } @else if (insights()?.tips?.length) {
          <div class="space-y-6">
            @for (tip of insights()?.tips; track tip.problem) {
              <div class="bg-gradient-to-br from-slate-900 to-slate-900/50 p-6 rounded-3xl border border-slate-800 relative overflow-hidden">
                <div class="absolute top-0 right-0 w-32 h-32 bg-emerald-500/5 rounded-full blur-2xl -mr-10 -mt-10 pointer-events-none"></div>
                
                <div class="flex items-start gap-4 mb-4">
                  <div class="w-10 h-10 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0">
                    <mat-icon>lightbulb</mat-icon>
                  </div>
                  <div>
                    <h3 class="font-medium text-slate-50 text-lg leading-tight">{{ tip.actionStep }}</h3>
                    <p class="text-emerald-400 font-medium text-sm mt-1">Save ~{{ tip.savingAmount | currency:'USD' }}/mo</p>
                  </div>
                </div>
                
                <div class="bg-slate-950/50 rounded-2xl p-4 border border-slate-800/50">
                  <p class="text-sm text-slate-300 mb-2"><span class="text-slate-500 font-medium">Observation:</span> {{ tip.problem }}</p>
                  @if (tip.explanation) {
                    <p class="text-sm text-slate-400"><span class="text-slate-500 font-medium">Why:</span> {{ tip.explanation }}</p>
                  }
                </div>
              </div>
            }
          </div>
          
          <div class="mt-8 text-center">
            <button (click)="generateNewInsights()" class="text-sm text-emerald-400 hover:text-emerald-300 font-medium flex items-center justify-center gap-2 mx-auto">
              <mat-icon class="text-sm w-5 h-5">refresh</mat-icon>
              Refresh Insights
            </button>
          </div>
        } @else {
          <div class="flex flex-col items-center justify-center py-12 text-center">
            <div class="w-16 h-16 bg-slate-900 text-slate-500 rounded-2xl flex items-center justify-center mb-4">
              <mat-icon class="text-3xl w-8 h-8">analytics</mat-icon>
            </div>
            <h3 class="text-lg font-medium text-slate-50 mb-2">Not enough data</h3>
            <p class="text-slate-400 text-sm max-w-[250px] mb-6">Add at least 7 transactions to get personalized AI insights.</p>
            
            @if (canGenerate()) {
              <button (click)="generateNewInsights()" class="bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-medium py-3 px-6 rounded-xl transition-colors flex items-center gap-2">
                <mat-icon>auto_awesome</mat-icon>
                Generate Now
              </button>
            }
          </div>
        }
      </div>
    </div>
  `
})
export class InsightsComponent {
  private firebase = inject(FirebaseService);
  private gemini = inject(GeminiService);

  insights = this.firebase.insights;
  expenses = this.firebase.expenses;
  
  isGenerating = signal(false);

  canGenerate = computed(() => {
    const monthExpenses = this.expenses();
    return monthExpenses.length >= 7;
  });

  async generateNewInsights() {
    const monthExpenses = this.expenses();
    
    if (monthExpenses.length < 7) {
      alert('You need at least 7 transactions to generate meaningful insights.');
      return;
    }

    this.isGenerating.set(true);
    try {
      const result = await this.gemini.generateInsights(monthExpenses);
      // Save to 'default' instead of currentMonth since we are ignoring dates
      await this.firebase.saveInsight('default', result.tips);
    } catch (e) {
      console.error('Failed to generate insights', e);
      alert('Failed to generate insights. Please try again.');
    } finally {
      this.isGenerating.set(false);
    }
  }
}


@Component({
  selector: 'app-budget',
  standalone: true,
  imports: [MatIconModule, CurrencyPipe, DecimalPipe, FormsModule],
  template: `
    <div class="pb-24 min-h-screen flex flex-col">
      <header class="p-6 pb-4 bg-slate-950 sticky top-0 z-10 border-b border-slate-900 flex justify-between items-center">
        <div>
          <h1 class="text-2xl font-semibold text-slate-50 mb-1">Budget Goals</h1>
          <p class="text-slate-400 text-sm">Manage your monthly spending limits</p>
        </div>
        <button (click)="saveBudgets()" [disabled]="isSaving()" class="bg-emerald-500 hover:bg-emerald-600 disabled:bg-slate-800 disabled:text-slate-500 text-slate-950 font-medium px-4 py-2 rounded-xl transition-colors text-sm">
          {{ isSaving() ? 'Saving...' : 'Save' }}
        </button>
      </header>

      <div class="flex-1 p-6 space-y-6">
        <div class="bg-slate-900 p-6 rounded-3xl border border-slate-800">
          <div class="flex justify-between items-end mb-2">
            <span class="text-slate-400 text-sm">Total Budget</span>
            <span class="text-slate-50 font-medium text-lg">{{ totalSpent() | currency:'USD' }} / {{ totalBudget() | currency:'USD' }}</span>
          </div>
          <div class="h-3 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
            <div class="h-full rounded-full transition-all duration-500" 
                 [class.bg-emerald-500]="overallPercentage() < 80"
                 [class.bg-amber-500]="overallPercentage() >= 80 && overallPercentage() <= 100"
                 [class.bg-red-500]="overallPercentage() > 100"
                 [style.width.%]="overallPercentage() > 100 ? 100 : overallPercentage()"></div>
          </div>
          @if (overallPercentage() > 100) {
            <p class="text-red-400 text-xs mt-2 flex items-center gap-1">
              <mat-icon class="text-[14px] w-3.5 h-3.5">warning</mat-icon>
              You've exceeded your total budget!
            </p>
          }
        </div>

        <div class="space-y-4">
          <h2 class="text-lg font-medium text-slate-50 mb-2">Categories</h2>
          
          @for (cat of categories; track cat.name) {
            <div class="bg-slate-900 p-4 rounded-2xl border border-slate-800">
              <div class="flex items-center justify-between mb-3">
                <div class="flex items-center gap-3">
                  <div class="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-slate-400">
                    <mat-icon class="text-sm w-5 h-5">{{ cat.icon }}</mat-icon>
                  </div>
                  <span class="font-medium text-slate-50">{{ cat.name }}</span>
                </div>
                <div class="flex items-center gap-1">
                  <span class="text-slate-500">$</span>
                  <input type="number" [(ngModel)]="localLimits[cat.name]" class="w-20 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1 text-right text-slate-50 outline-none focus:border-emerald-500 text-sm">
                </div>
              </div>
              
              <div class="flex justify-between text-xs mb-1">
                <span class="text-slate-400">Spent: {{ getSpentForCategory(cat.name) | currency:'USD' }}</span>
                <span [class.text-emerald-400]="getPercentage(cat.name) < 80"
                      [class.text-amber-400]="getPercentage(cat.name) >= 80 && getPercentage(cat.name) <= 100"
                      [class.text-red-400]="getPercentage(cat.name) > 100">
                  {{ getPercentage(cat.name) | number:'1.0-0' }}%
                </span>
              </div>
              <div class="h-1.5 bg-slate-950 rounded-full overflow-hidden">
                <div class="h-full rounded-full transition-all duration-500" 
                     [class.bg-emerald-500]="getPercentage(cat.name) < 80"
                     [class.bg-amber-500]="getPercentage(cat.name) >= 80 && getPercentage(cat.name) <= 100"
                     [class.bg-red-500]="getPercentage(cat.name) > 100"
                     [style.width.%]="getPercentage(cat.name) > 100 ? 100 : getPercentage(cat.name)"></div>
              </div>
            </div>
          }
        </div>
      </div>
    </div>
  `
})
export class BudgetComponent {
  private firebase = inject(FirebaseService);

  expenses = this.firebase.expenses;
  budgets = this.firebase.budgets;
  
  isSaving = signal(false);
  
  categories = [
    { name: 'Food', icon: 'restaurant' },
    { name: 'Transport', icon: 'directions_car' },
    { name: 'Rent', icon: 'home' },
    { name: 'Utilities', icon: 'bolt' },
    { name: 'Health', icon: 'favorite' },
    { name: 'Shopping', icon: 'shopping_bag' },
    { name: 'Entertainment', icon: 'movie' },
    { name: 'Other', icon: 'more_horiz' }
  ];

  localLimits: Record<string, number> = {};

  constructor() {
    effect(() => {
      const b = this.budgets();
      if (b && b.limits) {
        this.localLimits = { ...b.limits };
      } else {
        this.categories.forEach(c => {
          if (this.localLimits[c.name] === undefined) {
            this.localLimits[c.name] = 0;
          }
        });
      }
    });
  }

  totalSpent = computed(() => {
    return this.expenses()
      .reduce((sum, e) => sum + Number(e.amount || 0), 0);
  });

  totalBudget = computed(() => {
    return Object.values(this.localLimits).reduce((sum, limit) => sum + (limit || 0), 0);
  });

  overallPercentage = computed(() => {
    const spent = this.totalSpent();
    const budget = this.totalBudget();
    if (budget === 0) return 0;
    return (spent / budget) * 100;
  });

  getSpentForCategory(category: string): number {
    return this.expenses()
      .filter(e => e.category === category)
      .reduce((sum, e) => sum + Number(e.amount || 0), 0);
  }

  getPercentage(category: string): number {
    const spent = this.getSpentForCategory(category);
    const limit = this.localLimits[category] || 0;
    if (limit === 0) return spent > 0 ? 100 : 0;
    return (spent / limit) * 100;
  }

  async saveBudgets() {
    this.isSaving.set(true);
    try {
      const cleanLimits: Record<string, number> = {};
      for (const [k, v] of Object.entries(this.localLimits)) {
        cleanLimits[k] = Number(v) || 0;
      }
      await this.firebase.saveBudget('default', cleanLimits);
    } catch (e) {
      console.error('Failed to save budgets', e);
      alert('Failed to save budgets');
    } finally {
      this.isSaving.set(false);
    }
  }
}


@Component({
  selector: 'app-reports',
  standalone: true,
  imports: [MatIconModule, CurrencyPipe, DecimalPipe],
  template: `
    <div class="pb-24 min-h-screen flex flex-col">
      <header class="p-6 pb-4 bg-slate-950 sticky top-0 z-10 border-b border-slate-900">
        <h1 class="text-2xl font-semibold text-slate-50 mb-1">Reports</h1>
        <p class="text-slate-400 text-sm">Your spending breakdown</p>
      </header>

      <div class="flex-1 p-6 space-y-6">
        <div class="bg-slate-900 p-4 rounded-3xl border border-slate-800">
          <h2 class="text-sm font-medium text-slate-400 mb-4">Category Breakdown</h2>
          <div class="relative h-64 w-full">
            <canvas #donutChart></canvas>
          </div>
        </div>

        <div>
          <h2 class="text-lg font-medium text-slate-50 mb-3">Top Categories</h2>
          <div class="space-y-3">
            @for (cat of categoryBreakdown(); track cat.name) {
              <div class="bg-slate-900 p-4 rounded-2xl border border-slate-800 flex items-center justify-between">
                <div class="flex items-center gap-3">
                  <div class="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-slate-400">
                    <mat-icon class="text-sm w-5 h-5">{{ getCategoryIcon(cat.name) }}</mat-icon>
                  </div>
                  <span class="font-medium text-slate-50">{{ cat.name }}</span>
                </div>
                <div class="text-right">
                  <p class="font-medium text-slate-50">{{ cat.amount | currency:'USD' }}</p>
                  <p class="text-xs text-slate-400">{{ cat.percentage | number:'1.0-0' }}%</p>
                </div>
              </div>
            } @empty {
              <p class="text-slate-500 text-sm text-center py-4">No data for this month.</p>
            }
          </div>
        </div>
      </div>
    </div>
  `
})
export class ReportsComponent implements AfterViewInit {
  @ViewChild('donutChart') donutChartRef!: ElementRef<HTMLCanvasElement>;
  
  private firebase = inject(FirebaseService);
  private chartInstance: Chart | null = null;

  expenses = this.firebase.expenses;

  categoryBreakdown = computed(() => {
    const monthExpenses = this.expenses();
    
    const total = monthExpenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);
    if (total === 0) return [];

    const grouped = monthExpenses.reduce((acc, e) => {
      acc[e.category] = (acc[e.category] || 0) + Number(e.amount || 0);
      return acc;
    }, {} as Record<string, number>);

    return Object.entries(grouped)
      .map(([name, amount]) => ({
        name,
        amount,
        percentage: (amount / total) * 100
      }))
      .sort((a, b) => b.amount - a.amount);
  });

  constructor() {
    effect(() => {
      const data = this.categoryBreakdown();
      this.updateChart(data);
    });
  }

  ngAfterViewInit() {
    this.initChart();
    this.updateChart(this.categoryBreakdown());
  }

  initChart() {
    if (!this.donutChartRef) return;
    
    const ctx = this.donutChartRef.nativeElement.getContext('2d');
    if (!ctx) return;

    this.chartInstance = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: [],
        datasets: [{
          data: [],
          backgroundColor: [
            '#10b981',
            '#3b82f6',
            '#8b5cf6',
            '#f59e0b',
            '#ef4444',
            '#ec4899',
            '#06b6d4',
            '#64748b' 
          ],
          borderWidth: 0,
          hoverOffset: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'right',
            labels: {
              color: '#94a3b8',
              font: { family: 'Inter', size: 11 },
              padding: 15,
              usePointStyle: true,
              pointStyle: 'circle'
            }
          }
        },
        cutout: '75%'
      }
    });
  }

  updateChart(data: {name: string, amount: number, percentage: number}[]) {
    if (!this.chartInstance) return;
    
    this.chartInstance.data.labels = data.map(d => d.name);
    this.chartInstance.data.datasets[0].data = data.map(d => d.amount);
    this.chartInstance.update();
  }

  getCategoryIcon(category: string): string {
    const icons: Record<string, string> = {
      'Food': 'restaurant',
      'Transport': 'directions_car',
      'Rent': 'home',
      'Utilities': 'bolt',
      'Health': 'favorite',
      'Shopping': 'shopping_bag',
      'Entertainment': 'movie',
      'Other': 'more_horiz'
    };
    return icons[category] || 'receipt';
  }
}


@Component({
  selector: 'app-profile',
  standalone: true,
  imports: [MatIconModule],
  template: `
    <div class="pb-24 min-h-screen flex flex-col">
      <header class="p-6 pb-4 bg-slate-950 sticky top-0 z-10 border-b border-slate-900 flex items-center gap-4">
        <button (click)="goBack()" class="w-10 h-10 flex items-center justify-center text-slate-400 hover:text-slate-200 bg-slate-900 rounded-full">
          <mat-icon>arrow_back</mat-icon>
        </button>
        <h1 class="text-2xl font-semibold text-slate-50">Profile</h1>
      </header>

      <div class="flex-1 p-6 space-y-6">
        <div class="flex flex-col items-center justify-center py-6">
          <div class="w-24 h-24 rounded-full bg-slate-800 flex items-center justify-center text-slate-400 mb-4 border-4 border-slate-900 shadow-xl">
            <mat-icon class="text-5xl w-12 h-12">person</mat-icon>
          </div>
          <h2 class="text-xl font-medium text-slate-50">{{ user()?.displayName || 'User' }}</h2>
          <p class="text-slate-400 text-sm">{{ user()?.email }}</p>
        </div>

        <div class="bg-gradient-to-r from-amber-500/20 to-orange-500/20 border border-amber-500/30 p-5 rounded-3xl flex items-center justify-between">
          <div>
            <div class="flex items-center gap-2 text-amber-400 mb-1">
              <mat-icon class="text-sm w-5 h-5">workspace_premium</mat-icon>
              <span class="font-medium">SpendWise Premium</span>
            </div>
            <p class="text-slate-300 text-xs">Unlimited scans & family sharing</p>
          </div>
          <button class="bg-amber-500 hover:bg-amber-600 text-amber-950 font-medium px-4 py-2 rounded-xl text-sm transition-colors">
            Upgrade
          </button>
        </div>

        <div class="space-y-2">
          <h3 class="text-sm font-medium text-slate-400 px-2 mb-2">Settings</h3>
          
          <button class="w-full bg-slate-900 p-4 rounded-2xl border border-slate-800 flex items-center justify-between hover:bg-slate-800 transition-colors">
            <div class="flex items-center gap-3 text-slate-300">
              <mat-icon class="text-slate-400">payments</mat-icon>
              <span>Currency</span>
            </div>
            <div class="flex items-center gap-2 text-slate-500">
              <span class="text-sm">USD ($)</span>
              <mat-icon class="text-sm w-5 h-5">chevron_right</mat-icon>
            </div>
          </button>

          <button class="w-full bg-slate-900 p-4 rounded-2xl border border-slate-800 flex items-center justify-between hover:bg-slate-800 transition-colors">
            <div class="flex items-center gap-3 text-slate-300">
              <mat-icon class="text-slate-400">notifications</mat-icon>
              <span>Notifications</span>
            </div>
            <mat-icon class="text-slate-500 text-sm w-5 h-5">chevron_right</mat-icon>
          </button>

          <button class="w-full bg-slate-900 p-4 rounded-2xl border border-slate-800 flex items-center justify-between hover:bg-slate-800 transition-colors">
            <div class="flex items-center gap-3 text-slate-300">
              <mat-icon class="text-slate-400">group</mat-icon>
              <span>Family Sharing</span>
            </div>
            <mat-icon class="text-slate-500 text-sm w-5 h-5">chevron_right</mat-icon>
          </button>
        </div>

        <div class="pt-6">
          <button (click)="logout()" class="w-full bg-slate-900/50 border border-red-500/20 text-red-400 p-4 rounded-2xl flex items-center justify-center gap-2 hover:bg-red-500/10 transition-colors font-medium">
            <mat-icon>logout</mat-icon>
            Sign Out
          </button>
        </div>
      </div>
    </div>
  `
})
export class ProfileComponent {
  private firebase = inject(FirebaseService);
  private router = inject(Router);

  user = this.firebase.user;

  goBack() {
    this.router.navigate(['/dashboard']);
  }

  async logout() {
    await this.firebase.logout();
    this.router.navigate(['/onboarding']);
  }
}


@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MatIconModule],
  template: `
    <div class="min-h-screen bg-slate-950 text-slate-50 font-sans selection:bg-emerald-500/30">
      @if (!firebase.isAuthReady()) {
        <div class="min-h-screen flex items-center justify-center">
          <mat-icon class="animate-spin text-emerald-500">refresh</mat-icon>
        </div>
      } @else {
        <router-outlet></router-outlet>

        @if (firebase.user() && showNav()) {
          <nav class="fixed bottom-0 left-0 right-0 bg-slate-900/80 backdrop-blur-xl border-t border-slate-800 pb-safe pt-2 px-6 z-50">
            <div class="flex justify-between items-center max-w-md mx-auto">
              <a routerLink="/dashboard" routerLinkActive="text-emerald-400" [routerLinkActiveOptions]="{exact: true}" class="flex flex-col items-center p-2 text-slate-500 hover:text-slate-300 transition-colors">
                <mat-icon>home</mat-icon>
                <span class="text-[10px] font-medium mt-1">Home</span>
              </a>
              <a routerLink="/list" routerLinkActive="text-emerald-400" class="flex flex-col items-center p-2 text-slate-500 hover:text-slate-300 transition-colors">
                <mat-icon>receipt_long</mat-icon>
                <span class="text-[10px] font-medium mt-1">History</span>
              </a>
              
              <div class="relative -top-6">
                <a routerLink="/add" class="w-14 h-14 bg-emerald-500 hover:bg-emerald-400 text-slate-950 rounded-full flex items-center justify-center shadow-lg shadow-emerald-500/20 transition-transform hover:scale-105">
                  <mat-icon class="text-3xl w-8 h-8">add</mat-icon>
                </a>
              </div>

              <a routerLink="/reports" routerLinkActive="text-emerald-400" class="flex flex-col items-center p-2 text-slate-500 hover:text-slate-300 transition-colors">
                <mat-icon>bar_chart</mat-icon>
                <span class="text-[10px] font-medium mt-1">Reports</span>
              </a>
              <a routerLink="/insights" routerLinkActive="text-emerald-400" class="flex flex-col items-center p-2 text-slate-500 hover:text-slate-300 transition-colors">
                <mat-icon>lightbulb</mat-icon>
                <span class="text-[10px] font-medium mt-1">Insights</span>
              </a>
            </div>
          </nav>
        }
      }
    </div>
  `,
  styles: [`
    .pb-safe { padding-bottom: env(safe-area-inset-bottom, 1rem); }
  `]
})
export class App {
  firebase = inject(FirebaseService);
  router = inject(Router);

  showNav() {
    const hiddenRoutes = ['/onboarding', '/add', '/scan'];
    return !hiddenRoutes.includes(this.router.url);
  }
}



const authGuard: CanActivateFn = () => {
  const firebase = inject(FirebaseService);
  const router = inject(Router);
  
  if (firebase.isAuthReady() && firebase.user()) {
    return true;
  }
  
  router.navigate(['/onboarding']);
  return false;
};

const routes: Routes = [
  { path: 'onboarding', component: OnboardingComponent },
  { path: 'dashboard', component: DashboardComponent, canActivate: [authGuard] },
  { path: 'add', component: AddExpenseComponent, canActivate: [authGuard] },
  { path: 'scan', component: ScannerComponent, canActivate: [authGuard] },
  { path: 'list', component: ExpenseListComponent, canActivate: [authGuard] },
  { path: 'insights', component: InsightsComponent, canActivate: [authGuard] },
  { path: 'budget', component: BudgetComponent, canActivate: [authGuard] },
  { path: 'reports', component: ReportsComponent, canActivate: [authGuard] },
  { path: 'profile', component: ProfileComponent, canActivate: [authGuard] },
  { path: '', redirectTo: '/dashboard', pathMatch: 'full' },
  { path: '**', redirectTo: '/dashboard' }
];

const appConfig: ApplicationConfig = {
  providers: [provideBrowserGlobalErrorListeners(), provideRouter(routes)],
};

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
