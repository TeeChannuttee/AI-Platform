"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import {
    Shield,
    Activity,
    AlertTriangle,
    Bell,
    Clock,
    RefreshCw,
    CheckCircle2,
    XCircle,
    ChevronRight,
    LayoutGrid,
    LogOut,
    Zap,
    DollarSign,
    Search,
    Filter,
    Settings,
    Eye,
    Check,
    X,
    Radio,
    Hash,
    Globe,
    FileText,
    Lock,
    BarChart3,
    ShieldAlert,
    BellRing,
    Gauge,
    ToggleLeft,
    ToggleRight,
    UserPlus,
    Copy,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { adminApi, ApiRequestError } from "@/lib/api";
import type {
    DashboardStats,
    EventLogItem,
    SecurityLogItem,
    LLMUsageLogItem,
    AlertItem,
    AlertRuleItem,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// ─── Helpers ───

function formatDate(iso: string | null): string {
    if (!iso) return "—";
    // Ensure UTC interpretation if no timezone indicator
    const utcIso = iso.includes("Z") || iso.includes("+") ? iso : iso + "Z";
    return new Date(utcIso).toLocaleDateString("en-US", {
        month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
}

function formatTokens(n: number): string {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return n.toString();
}

function severityColor(s: string): string {
    switch (s.toUpperCase()) {
        case "CRITICAL": return "bg-red-100 text-red-700 border-red-200";
        case "HIGH": return "bg-orange-100 text-orange-700 border-orange-200";
        case "MED": case "MEDIUM": return "bg-amber-100 text-amber-700 border-amber-200";
        case "LOW": return "bg-sky-100 text-sky-700 border-sky-200";
        default: return "bg-muted text-muted-foreground border-border";
    }
}

function statusColor(s: string): string {
    switch (s.toLowerCase()) {
        case "open": return "bg-red-100 text-red-700";
        case "ack": case "acknowledged": return "bg-amber-100 text-amber-700";
        case "resolved": return "bg-emerald-100 text-emerald-700";
        case "success": return "bg-emerald-100 text-emerald-700";
        case "failure": case "error": return "bg-red-100 text-red-700";
        default: return "bg-muted text-muted-foreground";
    }
}

// ─── Tabs ───

type TabKey = "dashboard" | "events" | "security" | "llm" | "alerts" | "rules";

const TABS: { key: TabKey; label: string; icon: React.ElementType; adminOnly?: boolean }[] = [
    { key: "dashboard", label: "Dashboard", icon: Gauge },
    { key: "events", label: "Event Logs", icon: Activity },
    { key: "security", label: "Security", icon: Shield, adminOnly: true },
    { key: "llm", label: "LLM Usage", icon: BarChart3 },
    { key: "alerts", label: "Alerts", icon: Bell },
    { key: "rules", label: "Alert Rules", icon: Settings, adminOnly: true },
];

// ═══════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════

export default function AdminPage() {
    const router = useRouter();
    const { token, user, logout, isLoading: authLoading } = useAuth();
    const isAdmin = user?.role === "admin" || user?.roles?.includes("admin");

    const [tab, setTab] = useState<TabKey>("dashboard");
    const [loading, setLoading] = useState(true);

    // Data
    const [dashboard, setDashboard] = useState<DashboardStats | null>(null);
    const [events, setEvents] = useState<EventLogItem[]>([]);
    const [securityLogs, setSecurityLogs] = useState<SecurityLogItem[]>([]);
    const [llmLogs, setLlmLogs] = useState<LLMUsageLogItem[]>([]);
    const [alerts, setAlerts] = useState<AlertItem[]>([]);
    const [rules, setRules] = useState<AlertRuleItem[]>([]);

    // Filters
    const [evAction, setEvAction] = useState("");
    const [evResource, setEvResource] = useState("");
    const [secSeverity, setSecSeverity] = useState("");
    const [alertStatus, setAlertStatus] = useState("");
    const [llmModel, setLlmModel] = useState("");

    // SSE
    const sseRef = useRef<EventSource | null>(null);
    const [sseConnected, setSseConnected] = useState(false);

    // Rule editing
    const [editRule, setEditRule] = useState<AlertRuleItem | null>(null);
    const [editThreshold, setEditThreshold] = useState(0);
    const [editWindow, setEditWindow] = useState(0);
    const [editEnabled, setEditEnabled] = useState(true);
    const [savingRule, setSavingRule] = useState(false);

    // Invite
    const [showInvite, setShowInvite] = useState(false);
    const [invEmail, setInvEmail] = useState("");
    const [invRole, setInvRole] = useState("user");
    const [invToken, setInvToken] = useState("");
    const [inviting, setInviting] = useState(false);

    // Toast
    const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
    const showToast = useCallback((m: string, t: "success" | "error") => {
        setToast({ message: m, type: t });
        setTimeout(() => setToast(null), 4000);
    }, []);

    // ─── Load ───

    const loadDashboard = useCallback(async () => {
        if (!token) return;
        try {
            const data = await adminApi.dashboard(token);
            setDashboard(data);
        } catch { /* ignore */ }
    }, [token]);

    const loadEvents = useCallback(async () => {
        if (!token) return;
        try {
            const data = await adminApi.events(token, {
                action: evAction || undefined,
                resource_type: evResource || undefined,
                limit: 100,
            });
            setEvents(data);
        } catch { /* ignore */ }
    }, [token, evAction, evResource]);

    const loadSecurity = useCallback(async () => {
        if (!token || !isAdmin) return;
        try {
            const data = await adminApi.securityLogs(token, {
                severity: secSeverity || undefined,
                limit: 100,
            });
            setSecurityLogs(data);
        } catch (err) {
            if (err instanceof ApiRequestError && err.status === 403) {
                setSecurityLogs([]);
            }
        }
    }, [token, isAdmin, secSeverity]);

    const loadLLM = useCallback(async () => {
        if (!token) return;
        try {
            const data = await adminApi.llmUsageLogs(token, {
                model: llmModel || undefined,
                limit: 100,
            });
            setLlmLogs(data);
        } catch { /* ignore */ }
    }, [token, llmModel]);

    const loadAlerts = useCallback(async () => {
        if (!token) return;
        try {
            const data = await adminApi.alerts(token, {
                status: alertStatus || undefined,
            });
            setAlerts(data);
        } catch { /* ignore */ }
    }, [token, alertStatus]);

    const loadRules = useCallback(async () => {
        if (!token) return;
        try {
            const data = await adminApi.alertRules(token);
            setRules(data);
        } catch { /* ignore */ }
    }, [token]);

    // Initial load
    useEffect(() => {
        if (!authLoading && !token) { router.push("/login"); return; }
        if (!token) return;
        const init = async () => {
            setLoading(true);
            await Promise.all([loadDashboard(), loadAlerts()]);
            setLoading(false);
        };
        init();
    }, [token, authLoading, router, loadDashboard, loadAlerts]);

    // Tab-specific loading
    useEffect(() => {
        if (!token) return;
        if (tab === "events") loadEvents();
        if (tab === "security") loadSecurity();
        if (tab === "llm") loadLLM();
        if (tab === "alerts") loadAlerts();
        if (tab === "rules") loadRules();
    }, [tab, token, loadEvents, loadSecurity, loadLLM, loadAlerts, loadRules]);

    // SSE for alerts
    useEffect(() => {
        if (tab !== "alerts" || !token) return;
        const url = adminApi.alertStreamUrl(token);
        const es = new EventSource(url);
        sseRef.current = es;

        es.onopen = () => setSseConnected(true);
        es.onmessage = (event) => {
            try {
                const alert = JSON.parse(event.data);
                if (alert.id) {
                    setAlerts((prev) => [alert, ...prev.filter((a) => a.id !== alert.id)]);
                }
            } catch { /* ignore */ }
        };
        es.onerror = () => setSseConnected(false);

        return () => { es.close(); setSseConnected(false); };
    }, [tab, token]);

    // ─── Alert actions ───

    const handleAck = async (id: string) => {
        if (!token) return;
        try {
            await adminApi.ackAlert(token, id);
            setAlerts((prev) => prev.map((a) => a.id === id ? { ...a, status: "ack" } : a));
            showToast("Alert acknowledged", "success");
        } catch (err) {
            if (err instanceof ApiRequestError) showToast(err.data.detail, "error");
        }
    };

    const handleResolve = async (id: string) => {
        if (!token) return;
        try {
            await adminApi.resolveAlert(token, id);
            setAlerts((prev) => prev.map((a) => a.id === id ? { ...a, status: "resolved", resolved_at: new Date().toISOString() } : a));
            showToast("Alert resolved", "success");
        } catch (err) {
            if (err instanceof ApiRequestError) showToast(err.data.detail, "error");
        }
    };

    // ─── Rule editing ───

    const startEdit = (r: AlertRuleItem) => {
        setEditRule(r);
        setEditThreshold(r.threshold);
        setEditWindow(r.window_minutes);
        setEditEnabled(r.enabled);
    };

    const saveRule = async () => {
        if (!token || !editRule) return;
        setSavingRule(true);
        try {
            await adminApi.updateAlertRule(token, editRule.id, {
                threshold: editThreshold,
                window_minutes: editWindow,
                enabled: editEnabled,
            });
            showToast("Rule updated", "success");
            setEditRule(null);
            await loadRules();
        } catch (err) {
            if (err instanceof ApiRequestError) showToast(err.data.detail, "error");
        } finally {
            setSavingRule(false);
        }
    };

    // ─── Render ───

    if (authLoading || loading) {
        return (
            <div className="min-h-screen bg-background flex items-center justify-center">
                <div className="flex flex-col items-center gap-3">
                    <RefreshCw className="h-6 w-6 text-primary animate-spin" />
                    <p className="text-sm text-muted-foreground font-medium">Loading console…</p>
                </div>
            </div>
        );
    }

    // Filter tabs for non-admin
    const visibleTabs = TABS.filter((t) => !t.adminOnly || isAdmin);

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

            {/* Rule Edit Modal */}
            {editRule && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setEditRule(null)} />
                    <div className="relative bg-card rounded-2xl border border-border shadow-2xl max-w-md w-full p-6">
                        <h3 className="text-base font-bold text-foreground mb-1">{editRule.name}</h3>
                        <p className="text-xs text-muted-foreground mb-5">Condition: {editRule.condition_type}</p>
                        <div className="space-y-4">
                            <div>
                                <label className="text-xs font-semibold text-muted-foreground">Threshold</label>
                                <Input type="number" value={editThreshold} onChange={(e) => setEditThreshold(Number(e.target.value))} className="mt-1" />
                            </div>
                            <div>
                                <label className="text-xs font-semibold text-muted-foreground">Window (minutes)</label>
                                <Input type="number" value={editWindow} onChange={(e) => setEditWindow(Number(e.target.value))} className="mt-1" />
                            </div>
                            <div className="flex items-center gap-3">
                                <label className="text-xs font-semibold text-muted-foreground">Enabled</label>
                                <button onClick={() => setEditEnabled(!editEnabled)} className="text-primary">
                                    {editEnabled ? <ToggleRight className="h-6 w-6" /> : <ToggleLeft className="h-6 w-6 text-muted-foreground" />}
                                </button>
                            </div>
                        </div>
                        <div className="flex items-center gap-3 justify-end mt-6">
                            <Button variant="outline" onClick={() => setEditRule(null)} className="text-sm font-semibold">Cancel</Button>
                            <Button onClick={saveRule} disabled={savingRule} className="text-sm font-bold">
                                {savingRule ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : null}
                                Save
                            </Button>
                        </div>
                    </div>
                </div>
            )}

            {/* Header */}
            <header className="sticky top-0 z-30 bg-card/80 backdrop-blur-md border-b border-border">
                <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center text-primary-foreground">
                            <LayoutGrid className="h-4 w-4" />
                        </div>
                        <span className="font-bold text-foreground text-sm tracking-tight">Enterprise AI Platform</span>
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        <span className="font-semibold text-foreground text-sm">Admin Console</span>
                        {isAdmin && (
                            <span className="ml-1 text-[10px] font-bold bg-primary/10 text-primary px-2 py-0.5 rounded-full">ADMIN</span>
                        )}
                    </div>
                    <div className="flex items-center gap-2">
                        {isAdmin && (
                            <Button variant="outline" size="sm" onClick={() => { setShowInvite(true); setInvToken(""); setInvEmail(""); setInvRole("user"); }} className="text-xs font-semibold">
                                <UserPlus className="h-3.5 w-3.5 mr-1.5" /> Invite User
                            </Button>
                        )}
                        <Button variant="outline" size="sm" onClick={async () => { await logout(); router.push("/login"); }} className="text-xs font-semibold">
                            <LogOut className="h-3.5 w-3.5 mr-1.5" /> Sign Out
                        </Button>
                    </div>
                </div>
            </header>

            <main className="max-w-7xl mx-auto px-6 py-8 space-y-6">
                {/* Tabs */}
                <div className="flex items-center justify-between flex-wrap gap-3">
                    <div className="flex items-center gap-2 flex-wrap">
                        {visibleTabs.map((t) => {
                            const Icon = t.icon;
                            const alertCount = t.key === "alerts" ? alerts.filter((a) => a.status === "open").length : 0;
                            return (
                                <button
                                    key={t.key}
                                    onClick={() => setTab(t.key)}
                                    className={`flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-bold transition-all relative ${tab === t.key
                                        ? "bg-primary text-primary-foreground shadow-sm"
                                        : "bg-muted text-muted-foreground hover:bg-muted/80"
                                        }`}
                                >
                                    <Icon className="h-3 w-3" />
                                    {t.label}
                                    {alertCount > 0 && (
                                        <span className="ml-1 w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center">
                                            {alertCount}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {tab === "dashboard" && dashboard && (
                    <div className="space-y-6">
                        <div className="flex justify-end">
                            <Button variant="outline" size="sm" onClick={async () => { await Promise.all([loadDashboard(), loadAlerts()]); }} className="text-xs font-semibold">
                                <RefreshCw className="h-3 w-3 mr-1" /> Refresh
                            </Button>
                        </div>
                        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
                            {[
                                { label: "Events Today", value: dashboard.events_today, icon: Activity, color: "bg-blue-50 text-blue-600" },
                                { label: "Security Events", value: dashboard.security_events_today, icon: Shield, color: "bg-red-50 text-red-600" },
                                { label: "LLM Requests", value: dashboard.llm_requests_today, icon: Zap, color: "bg-violet-50 text-violet-600" },
                                { label: "Tokens Today", value: dashboard.tokens_today, icon: Hash, color: "bg-emerald-50 text-emerald-600", format: true },
                                { label: "Cost Today", value: dashboard.cost_today_usd, icon: DollarSign, color: "bg-amber-50 text-amber-600", isCost: true },
                                { label: "Open Alerts", value: dashboard.open_alerts, icon: Bell, color: dashboard.open_alerts > 0 ? "bg-red-50 text-red-600" : "bg-emerald-50 text-emerald-600" },
                            ].map((card) => {
                                const Icon = card.icon;
                                return (
                                    <div key={card.label} className="bg-card rounded-2xl border border-border shadow-sm p-5">
                                        <div className="flex items-center justify-between mb-3">
                                            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">{card.label}</span>
                                            <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${card.color}`}>
                                                <Icon className="h-3.5 w-3.5" />
                                            </div>
                                        </div>
                                        <p className="text-2xl font-bold text-foreground">
                                            {card.isCost ? `$${(card.value as number).toFixed(4)}` : card.format ? formatTokens(card.value as number) : card.value}
                                        </p>
                                    </div>
                                );
                            })}
                        </div>

                        {/* Quick nav */}
                        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                            {[
                                { label: "View Event Logs", tab: "events" as TabKey, icon: Activity, desc: "Browse all system events" },
                                { label: "Security Logs", tab: "security" as TabKey, icon: Shield, desc: "Admin-only security audit", admin: true },
                                { label: "LLM Usage", tab: "llm" as TabKey, icon: BarChart3, desc: "Token & cost breakdown" },
                                { label: "Manage Alerts", tab: "alerts" as TabKey, icon: Bell, desc: `${dashboard.open_alerts} open alerts` },
                            ].filter((n) => !n.admin || isAdmin).map((nav) => {
                                const Icon = nav.icon;
                                return (
                                    <button
                                        key={nav.label}
                                        onClick={() => setTab(nav.tab)}
                                        className="bg-card rounded-xl border border-border shadow-sm p-4 text-left hover:border-primary/30 transition-colors group"
                                    >
                                        <Icon className="h-5 w-5 text-primary mb-2" />
                                        <p className="text-sm font-bold text-foreground group-hover:text-primary transition-colors">{nav.label}</p>
                                        <p className="text-[10px] text-muted-foreground mt-0.5">{nav.desc}</p>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                )}

                {/* ═══ EVENT LOGS TAB ═══ */}
                {tab === "events" && (
                    <div className="space-y-4">
                        <div className="flex items-center gap-2 flex-wrap">
                            <Input placeholder="Filter by action…" value={evAction} onChange={(e) => setEvAction(e.target.value)} className="w-48 h-9 text-xs" />
                            <Input placeholder="Resource type…" value={evResource} onChange={(e) => setEvResource(e.target.value)} className="w-48 h-9 text-xs" />
                            <Button variant="outline" size="sm" onClick={loadEvents} className="text-xs font-semibold">
                                <Search className="h-3 w-3 mr-1" /> Search
                            </Button>
                        </div>

                        <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
                            <div className="hidden lg:grid grid-cols-12 gap-2 px-5 py-2.5 bg-muted/50 border-b border-border text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                                <div className="col-span-2">Timestamp</div>
                                <div className="col-span-2">Action</div>
                                <div className="col-span-1">Status</div>
                                <div className="col-span-2">Resource</div>
                                <div className="col-span-1">IP</div>
                                <div className="col-span-2">User</div>
                                <div className="col-span-2">Detail</div>
                            </div>
                            {events.length === 0 ? (
                                <div className="px-6 py-12 text-center">
                                    <Activity className="h-6 w-6 text-muted-foreground/40 mx-auto mb-2" />
                                    <p className="text-sm text-muted-foreground">No events found</p>
                                </div>
                            ) : (
                                <div className="divide-y divide-border max-h-[500px] overflow-y-auto">
                                    {events.map((ev) => (
                                        <div key={ev.id} className="grid grid-cols-1 lg:grid-cols-12 gap-2 px-5 py-2.5 items-center hover:bg-muted/20 transition-colors text-xs">
                                            <div className="col-span-2 text-muted-foreground">{formatDate(ev.timestamp)}</div>
                                            <div className="col-span-2 font-bold text-foreground">{ev.action}</div>
                                            <div className="col-span-1">
                                                <span className={`inline-flex text-[10px] font-bold px-2 py-0.5 rounded-full ${statusColor(ev.status)}`}>
                                                    {ev.status}
                                                </span>
                                            </div>
                                            <div className="col-span-2 text-muted-foreground">{ev.resource_type || "—"}{ev.resource_id ? ` #${ev.resource_id.slice(0, 8)}` : ""}</div>
                                            <div className="col-span-1 font-mono text-muted-foreground">{ev.ip || "—"}</div>
                                            <div className="col-span-2 font-mono text-muted-foreground truncate">{ev.user_id?.slice(0, 8) || "system"}</div>
                                            <div className="col-span-2 text-muted-foreground truncate">{ev.detail || "—"}</div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* ═══ SECURITY LOGS TAB ═══ */}
                {tab === "security" && (
                    <div className="space-y-4">
                        {!isAdmin ? (
                            <div className="bg-card rounded-2xl border border-border shadow-sm p-8 text-center">
                                <Lock className="h-8 w-8 text-muted-foreground/40 mx-auto mb-3" />
                                <h3 className="text-base font-bold text-foreground mb-1">Access Denied</h3>
                                <p className="text-sm text-muted-foreground">Security logs require admin privileges.</p>
                            </div>
                        ) : (
                            <>
                                <div className="flex items-center gap-2">
                                    <select
                                        value={secSeverity}
                                        onChange={(e) => setSecSeverity(e.target.value)}
                                        className="h-9 rounded-lg border border-border bg-background px-3 text-xs font-medium"
                                    >
                                        <option value="">All Severities</option>
                                        <option value="CRITICAL">Critical</option>
                                        <option value="HIGH">High</option>
                                        <option value="MED">Medium</option>
                                        <option value="LOW">Low</option>
                                    </select>
                                    <Button variant="outline" size="sm" onClick={loadSecurity} className="text-xs font-semibold">
                                        <RefreshCw className="h-3 w-3 mr-1" /> Refresh
                                    </Button>
                                </div>

                                <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
                                    <div className="hidden lg:grid grid-cols-12 gap-2 px-5 py-2.5 bg-muted/50 border-b border-border text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                                        <div className="col-span-2">Timestamp</div>
                                        <div className="col-span-2">Event Type</div>
                                        <div className="col-span-1">Severity</div>
                                        <div className="col-span-1">IP</div>
                                        <div className="col-span-3">Detail</div>
                                        <div className="col-span-3">Hash Chain</div>
                                    </div>
                                    {securityLogs.length === 0 ? (
                                        <div className="px-6 py-12 text-center">
                                            <Shield className="h-6 w-6 text-muted-foreground/40 mx-auto mb-2" />
                                            <p className="text-sm text-muted-foreground">No security logs found</p>
                                        </div>
                                    ) : (
                                        <div className="divide-y divide-border max-h-[500px] overflow-y-auto">
                                            {securityLogs.map((log) => (
                                                <div key={log.id} className="grid grid-cols-1 lg:grid-cols-12 gap-2 px-5 py-2.5 items-center hover:bg-muted/20 transition-colors text-xs">
                                                    <div className="col-span-2 text-muted-foreground">{formatDate(log.timestamp)}</div>
                                                    <div className="col-span-2 font-bold text-foreground">{log.event_type}</div>
                                                    <div className="col-span-1">
                                                        <span className={`inline-flex text-[10px] font-bold px-2 py-0.5 rounded-full border ${severityColor(log.severity)}`}>
                                                            {log.severity}
                                                        </span>
                                                    </div>
                                                    <div className="col-span-1 font-mono text-muted-foreground">{log.ip || "—"}</div>
                                                    <div className="col-span-3 text-muted-foreground truncate">{log.detail || "—"}</div>
                                                    <div className="col-span-3 font-mono text-[10px] text-muted-foreground truncate" title={log.prev_hash || undefined}>
                                                        {log.prev_hash ? `…${log.prev_hash.slice(-16)}` : "genesis"}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </>
                        )}
                    </div>
                )}

                {/* ═══ LLM USAGE LOGS TAB ═══ */}
                {tab === "llm" && (
                    <div className="space-y-4">
                        <div className="flex items-center gap-2">
                            <Input placeholder="Filter by model…" value={llmModel} onChange={(e) => setLlmModel(e.target.value)} className="w-48 h-9 text-xs" />
                            <Button variant="outline" size="sm" onClick={loadLLM} className="text-xs font-semibold">
                                <Search className="h-3 w-3 mr-1" /> Search
                            </Button>
                        </div>

                        <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
                            <div className="hidden lg:grid grid-cols-12 gap-2 px-5 py-2.5 bg-muted/50 border-b border-border text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                                <div className="col-span-2">Timestamp</div>
                                <div className="col-span-1">Model</div>
                                <div className="col-span-1 text-right">Prompt</div>
                                <div className="col-span-1 text-right">Completion</div>
                                <div className="col-span-1 text-right">Total</div>
                                <div className="col-span-1 text-right">Cost</div>
                                <div className="col-span-1 text-right">RAG ms</div>
                                <div className="col-span-1 text-right">Infer ms</div>
                                <div className="col-span-1">Version</div>
                                <div className="col-span-1">Citations</div>
                                <div className="col-span-1">User</div>
                            </div>
                            {llmLogs.length === 0 ? (
                                <div className="px-6 py-12 text-center">
                                    <BarChart3 className="h-6 w-6 text-muted-foreground/40 mx-auto mb-2" />
                                    <p className="text-sm text-muted-foreground">No LLM usage logs found</p>
                                </div>
                            ) : (
                                <div className="divide-y divide-border max-h-[500px] overflow-y-auto">
                                    {llmLogs.map((log) => (
                                        <div key={log.id} className="grid grid-cols-1 lg:grid-cols-12 gap-2 px-5 py-2.5 items-center hover:bg-muted/20 transition-colors text-xs">
                                            <div className="col-span-2 text-muted-foreground">{formatDate(log.created_at)}</div>
                                            <div className="col-span-1">
                                                <span className="text-[10px] font-bold bg-muted rounded px-1.5 py-0.5">{log.model}</span>
                                            </div>
                                            <div className="col-span-1 text-right text-muted-foreground">{formatTokens(log.prompt_tokens)}</div>
                                            <div className="col-span-1 text-right text-muted-foreground">{formatTokens(log.completion_tokens)}</div>
                                            <div className="col-span-1 text-right font-bold text-foreground">{formatTokens(log.total_tokens)}</div>
                                            <div className="col-span-1 text-right text-muted-foreground">{log.cost_usd != null ? `$${log.cost_usd.toFixed(4)}` : "—"}</div>
                                            <div className="col-span-1 text-right text-muted-foreground">{log.rag_latency_ms != null ? `${Math.round(log.rag_latency_ms)}` : "—"}</div>
                                            <div className="col-span-1 text-right text-muted-foreground">{log.infer_latency_ms != null ? `${Math.round(log.infer_latency_ms)}` : "—"}</div>
                                            <div className="col-span-1 text-muted-foreground">{log.pipeline_version || "—"}</div>
                                            <div className="col-span-1">
                                                {log.citation_count != null ? (
                                                    <span className="text-[10px]">
                                                        {log.citation_count}
                                                        {(log.citation_invalid_count ?? 0) > 0 && (
                                                            <span className="text-red-600 ml-0.5">({log.citation_invalid_count}✗)</span>
                                                        )}
                                                    </span>
                                                ) : "—"}
                                            </div>
                                            <div className="col-span-1 font-mono text-muted-foreground truncate">{log.user_id?.slice(0, 8) || "—"}</div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* ═══ ALERTS TAB ═══ */}
                {tab === "alerts" && (
                    <div className="space-y-4">
                        <div className="flex items-center gap-2 flex-wrap">
                            <select
                                value={alertStatus}
                                onChange={(e) => setAlertStatus(e.target.value)}
                                className="h-9 rounded-lg border border-border bg-background px-3 text-xs font-medium"
                            >
                                <option value="">All Status</option>
                                <option value="open">Open</option>
                                <option value="ack">Acknowledged</option>
                                <option value="resolved">Resolved</option>
                            </select>
                            <Button variant="outline" size="sm" onClick={loadAlerts} className="text-xs font-semibold">
                                <RefreshCw className="h-3 w-3 mr-1" /> Refresh
                            </Button>
                            {/* SSE indicator */}
                            <div className="ml-auto flex items-center gap-1.5">
                                <div className={`w-2 h-2 rounded-full ${sseConnected ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground/30"}`} />
                                <span className="text-[10px] text-muted-foreground font-medium">
                                    {sseConnected ? "Live" : "Disconnected"}
                                </span>
                            </div>
                        </div>

                        <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
                            {alerts.length === 0 ? (
                                <div className="px-6 py-12 text-center">
                                    <Bell className="h-6 w-6 text-muted-foreground/40 mx-auto mb-2" />
                                    <p className="text-sm text-muted-foreground">No alerts</p>
                                </div>
                            ) : (
                                <div className="divide-y divide-border max-h-[500px] overflow-y-auto">
                                    {alerts.map((alert) => (
                                        <div key={alert.id} className="flex items-start gap-4 px-5 py-4 hover:bg-muted/20 transition-colors">
                                            <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${alert.status === "open" ? "bg-red-100" : alert.status === "ack" ? "bg-amber-100" : "bg-emerald-100"
                                                }`}>
                                                {alert.status === "open" ? <BellRing className="h-4 w-4 text-red-600" /> : alert.status === "ack" ? <Eye className="h-4 w-4 text-amber-600" /> : <Check className="h-4 w-4 text-emerald-600" />}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2 flex-wrap">
                                                    <span className="text-sm font-bold text-foreground">{alert.rule_name}</span>
                                                    <span className={`inline-flex text-[10px] font-bold px-2 py-0.5 rounded-full border ${severityColor(alert.severity)}`}>
                                                        {alert.severity}
                                                    </span>
                                                    <span className={`inline-flex text-[10px] font-bold px-2 py-0.5 rounded-full ${statusColor(alert.status)}`}>
                                                        {alert.status}
                                                    </span>
                                                </div>
                                                <p className="text-xs text-muted-foreground mt-1">{alert.message}</p>
                                                <p className="text-[10px] text-muted-foreground mt-1">
                                                    {formatDate(alert.created_at)}
                                                    {alert.resolved_at && ` · Resolved ${formatDate(alert.resolved_at)}`}
                                                </p>
                                            </div>
                                            {/* Actions */}
                                            {alert.status !== "resolved" && (
                                                <div className="flex items-center gap-1.5 shrink-0">
                                                    {alert.status === "open" && (
                                                        <Button variant="outline" size="sm" onClick={() => handleAck(alert.id)} className="text-[10px] font-bold h-7 px-2">
                                                            <Eye className="h-3 w-3 mr-0.5" /> ACK
                                                        </Button>
                                                    )}
                                                    <Button variant="outline" size="sm" onClick={() => handleResolve(alert.id)} className="text-[10px] font-bold h-7 px-2 text-emerald-700 border-emerald-200 hover:bg-emerald-50">
                                                        <Check className="h-3 w-3 mr-0.5" /> Resolve
                                                    </Button>
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* ═══ ALERT RULES TAB ═══ */}
                {tab === "rules" && (
                    <div className="space-y-4">
                        {!isAdmin ? (
                            <div className="bg-card rounded-2xl border border-border shadow-sm p-8 text-center">
                                <Lock className="h-8 w-8 text-muted-foreground/40 mx-auto mb-3" />
                                <h3 className="text-base font-bold text-foreground mb-1">Access Denied</h3>
                                <p className="text-sm text-muted-foreground">Alert rules management requires admin privileges.</p>
                            </div>
                        ) : (
                            <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
                                <div className="hidden lg:grid grid-cols-12 gap-2 px-5 py-2.5 bg-muted/50 border-b border-border text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                                    <div className="col-span-3">Rule Name</div>
                                    <div className="col-span-2">Condition</div>
                                    <div className="col-span-1 text-right">Threshold</div>
                                    <div className="col-span-2 text-right">Window</div>
                                    <div className="col-span-1">Severity</div>
                                    <div className="col-span-1">Status</div>
                                    <div className="col-span-2 text-right">Actions</div>
                                </div>
                                {rules.length === 0 ? (
                                    <div className="px-6 py-12 text-center">
                                        <Settings className="h-6 w-6 text-muted-foreground/40 mx-auto mb-2" />
                                        <p className="text-sm text-muted-foreground">No alert rules configured</p>
                                    </div>
                                ) : (
                                    <div className="divide-y divide-border">
                                        {rules.map((rule) => (
                                            <div key={rule.id} className="grid grid-cols-1 lg:grid-cols-12 gap-2 px-5 py-3 items-center hover:bg-muted/20 transition-colors text-xs">
                                                <div className="col-span-3 font-bold text-foreground">{rule.name}</div>
                                                <div className="col-span-2 text-muted-foreground">{rule.condition_type}</div>
                                                <div className="col-span-1 text-right font-bold text-foreground">{rule.threshold}</div>
                                                <div className="col-span-2 text-right text-muted-foreground">{rule.window_minutes} min</div>
                                                <div className="col-span-1">
                                                    <span className={`inline-flex text-[10px] font-bold px-2 py-0.5 rounded-full border ${severityColor(rule.severity)}`}>
                                                        {rule.severity}
                                                    </span>
                                                </div>
                                                <div className="col-span-1">
                                                    <span className={`inline-flex text-[10px] font-bold px-2 py-0.5 rounded-full ${rule.enabled ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground"}`}>
                                                        {rule.enabled ? "ON" : "OFF"}
                                                    </span>
                                                </div>
                                                <div className="col-span-2 text-right">
                                                    <Button variant="outline" size="sm" onClick={() => startEdit(rule)} className="text-[10px] font-bold h-7 px-2">
                                                        <Settings className="h-3 w-3 mr-0.5" /> Edit
                                                    </Button>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </main>
            {/* Invite User Modal */}
            {showInvite && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
                    <div className="bg-card border border-border rounded-2xl p-6 w-full max-w-md shadow-2xl space-y-4">
                        <div className="flex items-center justify-between">
                            <h3 className="text-lg font-bold text-foreground flex items-center gap-2"><UserPlus className="h-5 w-5 text-primary" /> Invite User</h3>
                            <button onClick={() => setShowInvite(false)} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
                        </div>

                        {!invToken ? (
                            <>
                                <div>
                                    <label className="text-sm font-semibold mb-1.5 block">Email (optional)</label>
                                    <Input placeholder="user@company.com" value={invEmail} onChange={(e) => setInvEmail(e.target.value)} />
                                    <p className="text-[10px] text-muted-foreground mt-1">Leave empty to allow any email</p>
                                </div>
                                <div>
                                    <label className="text-sm font-semibold mb-1.5 block">Role</label>
                                    <select value={invRole} onChange={(e) => setInvRole(e.target.value)} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm">
                                        <option value="user">User</option>
                                        <option value="admin">Admin</option>
                                    </select>
                                </div>
                                <Button className="w-full" disabled={inviting} onClick={async () => {
                                    if (!token) return;
                                    setInviting(true);
                                    try {
                                        const res = await adminApi.createInvite(token, {
                                            role: invRole,
                                            ...(invEmail.trim() ? { email: invEmail.trim() } : {}),
                                        });
                                        setInvToken(res.token);
                                        showToast("Invite created!", "success");
                                    } catch {
                                        showToast("Failed to create invite", "error");
                                    } finally {
                                        setInviting(false);
                                    }
                                }}>
                                    {inviting ? <RefreshCw className="h-4 w-4 animate-spin mr-2" /> : <UserPlus className="h-4 w-4 mr-2" />}
                                    Create Invite
                                </Button>
                            </>
                        ) : (
                            <div className="space-y-3">
                                <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-center">
                                    <CheckCircle2 className="h-6 w-6 text-emerald-600 mx-auto mb-2" />
                                    <p className="text-sm font-semibold text-emerald-800">Invite Token Created!</p>
                                    <p className="text-[10px] text-emerald-600 mt-0.5">⚠️ Copy now — it will NOT be shown again</p>
                                </div>
                                <div className="bg-muted rounded-lg p-3 flex items-center gap-2">
                                    <code className="flex-1 text-xs font-mono break-all text-foreground">{invToken}</code>
                                    <button onClick={() => { navigator.clipboard.writeText(invToken); showToast("Copied!", "success"); }} className="shrink-0 p-1.5 rounded-md hover:bg-background transition-colors">
                                        <Copy className="h-4 w-4 text-muted-foreground" />
                                    </button>
                                </div>
                                <div className="bg-muted/50 rounded-lg p-3 text-xs text-muted-foreground">
                                    <p className="font-semibold text-foreground mb-1">Send this to the user:</p>
                                    <p>1. Go to <code className="bg-background px-1 rounded">/register</code></p>
                                    <p>2. Paste the token above</p>
                                    <p>3. Create their account</p>
                                </div>
                                <Button variant="outline" className="w-full" onClick={() => setShowInvite(false)}>
                                    Done
                                </Button>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
