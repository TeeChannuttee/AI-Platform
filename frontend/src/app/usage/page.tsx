"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
    BarChart3,
    RefreshCw,
    AlertTriangle,
    CheckCircle2,
    XCircle,
    ChevronRight,
    LayoutGrid,
    LogOut,
    Zap,
    Clock,
    Download,
    TrendingUp,
    DollarSign,
    Activity,
    Hash,
    Calendar,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { usageApi, ApiRequestError } from "@/lib/api";
import type { UsageMessage, UsageAggregate } from "@/lib/api";
import { Button } from "@/components/ui/button";

// ─── Helpers ───

function formatDate(iso: string | null): string {
    if (!iso) return "—";
    const utcIso = iso.includes("Z") || iso.includes("+") ? iso : iso + "Z";
    return new Date(utcIso).toLocaleDateString("en-US", {
        year: "numeric", month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit",
    });
}

function formatPeriod(iso: string, tab: string): string {
    const d = new Date(iso);
    if (tab === "daily") return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    if (tab === "weekly") return `Week of ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
    return d.toLocaleDateString("en-US", { year: "numeric", month: "long" });
}

function formatTokens(n: number): string {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return n.toString();
}

function formatCost(n: number | null): string {
    if (n === null || n === undefined) return "—";
    return `$${n.toFixed(4)}`;
}

function formatMs(n: number | null): string {
    if (n === null || n === undefined) return "—";
    return `${Math.round(n)}ms`;
}

// ─── Tabs ───

type TabKey = "messages" | "daily" | "weekly" | "monthly";

const TABS: { key: TabKey; label: string; icon: React.ElementType }[] = [
    { key: "messages", label: "Per Message", icon: Hash },
    { key: "daily", label: "Daily", icon: Calendar },
    { key: "weekly", label: "Weekly", icon: Calendar },
    { key: "monthly", label: "Monthly", icon: Calendar },
];

// ─── Simple Bar Chart ───

function BarChartSimple({
    data,
    tab,
}: {
    data: UsageAggregate[];
    tab: string;
}) {
    if (data.length === 0) return null;

    const reversed = [...data].reverse();
    const maxTokens = Math.max(...reversed.map((d) => d.total_tokens), 1);

    return (
        <div className="bg-card rounded-2xl border border-border shadow-sm p-6 mb-6">
            <h3 className="text-sm font-bold text-foreground mb-4">Token Usage</h3>
            <div className="flex items-end gap-1" style={{ height: 180 }}>
                {reversed.map((d, idx) => {
                    const h = Math.max((d.total_tokens / maxTokens) * 160, 4);
                    const promptH = d.total_prompt_tokens > 0
                        ? Math.max((d.total_prompt_tokens / maxTokens) * 160, 2)
                        : 0;
                    const completionH = h - promptH;

                    return (
                        <div
                            key={idx}
                            className="flex-1 flex flex-col justify-end items-center gap-0 group relative"
                        >
                            {/* Tooltip */}
                            <div className="absolute bottom-full mb-2 hidden group-hover:block z-10">
                                <div className="bg-foreground text-background text-[10px] font-medium px-2.5 py-1.5 rounded-lg shadow-lg whitespace-nowrap">
                                    <p className="font-bold">{formatPeriod(d.period, tab)}</p>
                                    <p>{formatTokens(d.total_tokens)} tokens · {d.request_count} req</p>
                                    {d.total_cost_usd > 0 && <p>{formatCost(d.total_cost_usd)}</p>}
                                </div>
                            </div>
                            {/* Bar */}
                            <div
                                className="w-full rounded-t-sm transition-all duration-300"
                                style={{ height: `${completionH}px` }}
                            >
                                <div className="w-full h-full bg-primary/60 rounded-t-sm" />
                            </div>
                            {promptH > 0 && (
                                <div
                                    className="w-full"
                                    style={{ height: `${promptH}px` }}
                                >
                                    <div className="w-full h-full bg-primary" />
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
            {/* X-axis labels */}
            <div className="flex gap-1 mt-2">
                {reversed.map((d, idx) => (
                    <div key={idx} className="flex-1 text-center">
                        {(idx % Math.ceil(reversed.length / 8) === 0 || reversed.length <= 10) && (
                            <span className="text-[9px] text-muted-foreground">{formatPeriod(d.period, tab).split(" ").slice(0, 2).join(" ")}</span>
                        )}
                    </div>
                ))}
            </div>
            {/* Legend */}
            <div className="flex items-center gap-4 mt-3 justify-end">
                <div className="flex items-center gap-1.5">
                    <div className="w-3 h-3 rounded-sm bg-primary" />
                    <span className="text-[10px] text-muted-foreground">Prompt</span>
                </div>
                <div className="flex items-center gap-1.5">
                    <div className="w-3 h-3 rounded-sm bg-primary/60" />
                    <span className="text-[10px] text-muted-foreground">Completion</span>
                </div>
            </div>
        </div>
    );
}

// ─── CSV Export ───

function exportCSV(data: UsageAggregate[], tab: string) {
    const headers = ["Period", "Requests", "Prompt Tokens", "Completion Tokens", "Total Tokens", "Cost (USD)", "Avg RAG Latency (ms)", "Avg Infer Latency (ms)"];
    const rows = data.map((d) => [
        formatPeriod(d.period, tab),
        d.request_count,
        d.total_prompt_tokens,
        d.total_completion_tokens,
        d.total_tokens,
        d.total_cost_usd.toFixed(4),
        Math.round(d.avg_rag_latency_ms),
        Math.round(d.avg_infer_latency_ms),
    ]);
    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `usage_${tab}_${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

function exportMessagesCSV(data: UsageMessage[]) {
    const headers = ["Timestamp", "Conversation", "Model", "Prompt", "Completion", "Total", "Cost (USD)", "RAG Latency (ms)", "Infer Latency (ms)"];
    const rows = data.map((d) => [
        d.created_at || "",
        d.conversation_id || "",
        d.model,
        d.prompt_tokens,
        d.completion_tokens,
        d.total_tokens,
        d.cost_usd?.toFixed(4) ?? "",
        d.rag_latency_ms ?? "",
        d.infer_latency_ms ?? "",
    ]);
    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `usage_messages_${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

// ═══════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════

export default function UsagePage() {
    const router = useRouter();
    const { token, logout, isLoading: authLoading } = useAuth();

    const [tab, setTab] = useState<TabKey>("daily");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Data
    const [messages, setMessages] = useState<UsageMessage[]>([]);
    const [dailyData, setDailyData] = useState<UsageAggregate[]>([]);
    const [weeklyData, setWeeklyData] = useState<UsageAggregate[]>([]);
    const [monthlyData, setMonthlyData] = useState<UsageAggregate[]>([]);

    // Toast
    const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
    const showToast = useCallback((m: string, t: "success" | "error") => {
        setToast({ message: m, type: t });
        setTimeout(() => setToast(null), 4000);
    }, []);

    // ─── Load ───

    const loadData = useCallback(async () => {
        if (!token) return;
        setLoading(true);
        setError(null);
        try {
            const [msgs, daily, weekly, monthly] = await Promise.all([
                usageApi.messages(token),
                usageApi.daily(token),
                usageApi.weekly(token),
                usageApi.monthly(token),
            ]);
            setMessages(msgs);
            setDailyData(daily);
            setWeeklyData(weekly);
            setMonthlyData(monthly);
        } catch (err) {
            if (err instanceof ApiRequestError) {
                if (err.status === 401) { await logout(); router.push("/login"); return; }
                setError(err.message);
            } else {
                setError("Cannot connect to server");
            }
        } finally {
            setLoading(false);
        }
    }, [token, logout, router]);

    useEffect(() => {
        if (!authLoading && !token) { router.push("/login"); return; }
        if (token) loadData();
    }, [token, authLoading, router, loadData]);

    // ─── Summary cards ───

    const summaryCards = useMemo(() => {
        const todayStr = new Date().toISOString().split("T")[0];
        const todayData = dailyData.find((d) => d.period.startsWith(todayStr));
        const thisWeekData = weeklyData.length > 0 ? weeklyData[0] : null;
        const thisMonthData = monthlyData.length > 0 ? monthlyData[0] : null;

        return [
            {
                label: "Today",
                tokens: todayData?.total_tokens ?? 0,
                requests: todayData?.request_count ?? 0,
                cost: todayData?.total_cost_usd ?? 0,
                icon: Zap,
                color: "bg-blue-50 text-blue-600",
            },
            {
                label: "This Week",
                tokens: thisWeekData?.total_tokens ?? 0,
                requests: thisWeekData?.request_count ?? 0,
                cost: thisWeekData?.total_cost_usd ?? 0,
                icon: TrendingUp,
                color: "bg-violet-50 text-violet-600",
            },
            {
                label: "This Month",
                tokens: thisMonthData?.total_tokens ?? 0,
                requests: thisMonthData?.request_count ?? 0,
                cost: thisMonthData?.total_cost_usd ?? 0,
                icon: Activity,
                color: "bg-emerald-50 text-emerald-600",
            },
            {
                label: "All Time",
                tokens: messages.reduce((s, m) => s + m.total_tokens, 0),
                requests: messages.length,
                cost: messages.reduce((s, m) => s + (m.cost_usd ?? 0), 0),
                icon: DollarSign,
                color: "bg-amber-50 text-amber-600",
            },
        ];
    }, [dailyData, weeklyData, monthlyData, messages]);

    // Current aggregate data
    const currentAggregate = tab === "daily" ? dailyData : tab === "weekly" ? weeklyData : tab === "monthly" ? monthlyData : [];

    // ─── Render ───

    if (authLoading || loading) {
        return (
            <div className="min-h-screen bg-background flex items-center justify-center">
                <div className="flex flex-col items-center gap-3">
                    <RefreshCw className="h-6 w-6 text-primary animate-spin" />
                    <p className="text-sm text-muted-foreground font-medium">Loading analytics…</p>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="min-h-screen bg-background flex items-center justify-center p-4">
                <div className="bg-card rounded-2xl border border-border shadow-sm p-8 max-w-md w-full text-center">
                    <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center mx-auto mb-4">
                        <AlertTriangle className="h-6 w-6 text-destructive" />
                    </div>
                    <h2 className="text-lg font-bold text-foreground mb-2">Something went wrong</h2>
                    <p className="text-muted-foreground text-sm mb-6">{error}</p>
                    <Button onClick={loadData} variant="outline">
                        <RefreshCw className="h-4 w-4 mr-2" /> Retry
                    </Button>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-background">
            {/* Toast */}
            {toast && (
                <div className="fixed top-6 right-6 z-50 animate-in slide-in-from-top-2 fade-in duration-300">
                    <div className={`flex items-center gap-3 px-5 py-3.5 rounded-xl shadow-lg border ${toast.type === "success"
                        ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                        : "bg-red-50 border-red-200 text-red-800"
                        }`}>
                        {toast.type === "success" ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <XCircle className="h-4 w-4 shrink-0" />}
                        <p className="text-sm font-semibold">{toast.message}</p>
                    </div>
                </div>
            )}

            {/* Header */}
            <header className="sticky top-0 z-30 bg-card/80 backdrop-blur-md border-b border-border">
                <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center text-primary-foreground">
                            <LayoutGrid className="h-4 w-4" />
                        </div>
                        <span className="font-bold text-foreground text-sm tracking-tight">Enterprise AI Platform</span>
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        <span className="font-semibold text-foreground text-sm">Usage Analytics</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" onClick={loadData} className="text-xs font-semibold">
                            <RefreshCw className="h-3 w-3 mr-1" /> Refresh
                        </Button>
                        <Button
                            variant="outline" size="sm"
                            onClick={async () => { await logout(); router.push("/login"); }}
                            className="text-xs font-semibold"
                        >
                            <LogOut className="h-3.5 w-3.5 mr-1.5" /> Sign Out
                        </Button>
                    </div>
                </div>
            </header>

            <main className="max-w-6xl mx-auto px-6 py-8 space-y-8">
                {/* ═══ SUMMARY CARDS ═══ */}
                <section>
                    <div className="flex items-center gap-2.5 mb-5">
                        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                            <BarChart3 className="h-4 w-4 text-primary" />
                        </div>
                        <div>
                            <h2 className="text-lg font-bold text-foreground">Usage Analytics</h2>
                            <p className="text-xs text-muted-foreground">Token consumption and cost tracking</p>
                        </div>
                    </div>

                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                        {summaryCards.map((card) => {
                            const Icon = card.icon;
                            return (
                                <div key={card.label} className="bg-card rounded-2xl border border-border shadow-sm p-5">
                                    <div className="flex items-center justify-between mb-3">
                                        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{card.label}</span>
                                        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${card.color}`}>
                                            <Icon className="h-4 w-4" />
                                        </div>
                                    </div>
                                    <p className="text-2xl font-bold text-foreground">{formatTokens(card.tokens)}</p>
                                    <p className="text-xs text-muted-foreground mt-0.5">tokens</p>
                                    <div className="flex items-center gap-3 mt-3 pt-3 border-t border-border/50">
                                        <span className="text-xs text-muted-foreground">
                                            <span className="font-bold text-foreground">{card.requests}</span> requests
                                        </span>
                                        {card.cost > 0 && (
                                            <span className="text-xs text-muted-foreground">
                                                <span className="font-bold text-foreground">{formatCost(card.cost)}</span>
                                            </span>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </section>

                {/* ═══ TABS ═══ */}
                <div className="flex items-center gap-2 flex-wrap">
                    {TABS.map((t) => (
                        <button
                            key={t.key}
                            onClick={() => setTab(t.key)}
                            className={`flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-bold transition-all ${tab === t.key
                                ? "bg-primary text-primary-foreground shadow-sm"
                                : "bg-muted text-muted-foreground hover:bg-muted/80"
                                }`}
                        >
                            <t.icon className="h-3 w-3" />
                            {t.label}
                        </button>
                    ))}

                    {/* Export CSV */}
                    <Button
                        variant="outline" size="sm"
                        onClick={() => {
                            if (tab === "messages") exportMessagesCSV(messages);
                            else exportCSV(currentAggregate, tab);
                        }}
                        className="ml-auto text-xs font-semibold"
                    >
                        <Download className="h-3 w-3 mr-1" /> Export CSV
                    </Button>
                </div>

                {/* ═══ CHART (aggregate tabs only) ═══ */}
                {tab !== "messages" && (
                    <BarChartSimple data={currentAggregate} tab={tab} />
                )}

                {/* ═══ TABLE ═══ */}
                <section>
                    <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">

                        {/* Per-message table */}
                        {tab === "messages" && (
                            <>
                                <div className="hidden lg:grid grid-cols-12 gap-4 px-6 py-3 bg-muted/50 border-b border-border text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                                    <div className="col-span-2">Timestamp</div>
                                    <div className="col-span-2">Conversation</div>
                                    <div className="col-span-1">Model</div>
                                    <div className="col-span-1 text-right">Prompt</div>
                                    <div className="col-span-1 text-right">Completion</div>
                                    <div className="col-span-1 text-right">Total</div>
                                    <div className="col-span-1 text-right">Cost</div>
                                    <div className="col-span-1 text-right">RAG</div>
                                    <div className="col-span-1 text-right">Infer</div>
                                </div>
                                {messages.length === 0 ? (
                                    <div className="px-6 py-16 text-center">
                                        <BarChart3 className="h-7 w-7 text-muted-foreground/40 mx-auto mb-3" />
                                        <h3 className="text-base font-bold text-foreground mb-1">No usage data</h3>
                                        <p className="text-sm text-muted-foreground">Start chatting with the AI to generate usage logs.</p>
                                    </div>
                                ) : (
                                    <div className="divide-y divide-border max-h-[600px] overflow-y-auto">
                                        {messages.map((msg) => (
                                            <div key={msg.id} className="grid grid-cols-1 lg:grid-cols-12 gap-2 lg:gap-4 px-6 py-3 items-center hover:bg-muted/20 transition-colors text-sm">
                                                <div className="col-span-2 flex items-center gap-1.5">
                                                    <Clock className="h-3 w-3 text-muted-foreground shrink-0" />
                                                    <span className="text-xs text-muted-foreground">{formatDate(msg.created_at)}</span>
                                                </div>
                                                <div className="col-span-2">
                                                    {msg.conversation_id ? (
                                                        <button
                                                            onClick={() => router.push(`/conversations/${msg.conversation_id}`)}
                                                            className="text-xs font-mono text-primary hover:underline truncate block"
                                                        >
                                                            {msg.conversation_id.slice(0, 8)}…
                                                        </button>
                                                    ) : (
                                                        <span className="text-xs text-muted-foreground">—</span>
                                                    )}
                                                </div>
                                                <div className="col-span-1">
                                                    <span className="text-[11px] font-bold text-muted-foreground bg-muted rounded px-1.5 py-0.5">{msg.model}</span>
                                                </div>
                                                <div className="col-span-1 text-right text-xs text-muted-foreground">{formatTokens(msg.prompt_tokens)}</div>
                                                <div className="col-span-1 text-right text-xs text-muted-foreground">{formatTokens(msg.completion_tokens)}</div>
                                                <div className="col-span-1 text-right text-xs font-bold text-foreground">{formatTokens(msg.total_tokens)}</div>
                                                <div className="col-span-1 text-right text-xs text-muted-foreground">{formatCost(msg.cost_usd)}</div>
                                                <div className="col-span-1 text-right text-xs text-muted-foreground">{formatMs(msg.rag_latency_ms)}</div>
                                                <div className="col-span-1 text-right text-xs text-muted-foreground">{formatMs(msg.infer_latency_ms)}</div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </>
                        )}

                        {/* Aggregate tables */}
                        {tab !== "messages" && (
                            <>
                                <div className="hidden lg:grid grid-cols-12 gap-4 px-6 py-3 bg-muted/50 border-b border-border text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                                    <div className="col-span-2">Period</div>
                                    <div className="col-span-1 text-right">Requests</div>
                                    <div className="col-span-2 text-right">Prompt</div>
                                    <div className="col-span-2 text-right">Completion</div>
                                    <div className="col-span-1 text-right">Total</div>
                                    <div className="col-span-1 text-right">Cost</div>
                                    <div className="col-span-1 text-right">Avg RAG</div>
                                    <div className="col-span-1 text-right">Avg Infer</div>
                                </div>
                                {currentAggregate.length === 0 ? (
                                    <div className="px-6 py-16 text-center">
                                        <BarChart3 className="h-7 w-7 text-muted-foreground/40 mx-auto mb-3" />
                                        <h3 className="text-base font-bold text-foreground mb-1">No data for this period</h3>
                                        <p className="text-sm text-muted-foreground">Start using the AI assistant to see analytics.</p>
                                    </div>
                                ) : (
                                    <div className="divide-y divide-border">
                                        {currentAggregate.map((row, idx) => (
                                            <div key={idx} className="grid grid-cols-1 lg:grid-cols-12 gap-2 lg:gap-4 px-6 py-3 items-center hover:bg-muted/20 transition-colors text-sm">
                                                <div className="col-span-2">
                                                    <span className="text-xs font-bold text-foreground">{formatPeriod(row.period, tab)}</span>
                                                </div>
                                                <div className="col-span-1 text-right">
                                                    <span className="text-xs font-bold text-foreground">{row.request_count}</span>
                                                </div>
                                                <div className="col-span-2 text-right text-xs text-muted-foreground">{formatTokens(row.total_prompt_tokens)}</div>
                                                <div className="col-span-2 text-right text-xs text-muted-foreground">{formatTokens(row.total_completion_tokens)}</div>
                                                <div className="col-span-1 text-right text-xs font-bold text-primary">{formatTokens(row.total_tokens)}</div>
                                                <div className="col-span-1 text-right text-xs text-muted-foreground">{formatCost(row.total_cost_usd)}</div>
                                                <div className="col-span-1 text-right text-xs text-muted-foreground">{formatMs(row.avg_rag_latency_ms)}</div>
                                                <div className="col-span-1 text-right text-xs text-muted-foreground">{formatMs(row.avg_infer_latency_ms)}</div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </section>
            </main>
        </div>
    );
}
