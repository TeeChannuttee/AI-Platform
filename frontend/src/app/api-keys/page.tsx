"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
    Key,
    Plus,
    Copy,
    Check,
    AlertTriangle,
    RefreshCw,
    RotateCw,
    Trash2,
    ChevronRight,
    LayoutGrid,
    LogOut,
    Shield,
    Eye,
    EyeOff,
    ArrowRightLeft,
    XCircle,
    CheckCircle2,
    Info,
    Zap,
    Clock,
    X,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { apiKeyApi, ApiRequestError } from "@/lib/api";
import type { ApiKeyInfo, CreatedApiKeyResponse, RotatedApiKeyResponse } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// ─── Helpers ───

function formatDate(iso: string | null): string {
    if (!iso) return "—";
    const utcIso = iso.includes("Z") || iso.includes("+") ? iso : iso + "Z";
    return new Date(utcIso).toLocaleDateString("en-US", {
        year: "numeric", month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit",
    });
}

function formatNumber(n: number | null): string {
    if (n === null || n === undefined) return "N/A";
    return n.toLocaleString();
}

const STATUS_STYLES: Record<string, { bg: string; text: string; dot: string }> = {
    active: { bg: "bg-emerald-50", text: "text-emerald-700", dot: "bg-emerald-500" },
    next: { bg: "bg-blue-50", text: "text-blue-700", dot: "bg-blue-500" },
    retired: { bg: "bg-slate-100", text: "text-slate-500", dot: "bg-slate-400" },
    revoked: { bg: "bg-red-50", text: "text-red-700", dot: "bg-red-500" },
};

// ═══════════════════════════════════════════════
// MODAL COMPONENT
// ═══════════════════════════════════════════════

function Modal({
    open, onClose, children,
}: {
    open: boolean;
    onClose: () => void;
    children: React.ReactNode;
}) {
    if (!open) return null;
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
            <div className="relative bg-card rounded-2xl border border-border shadow-2xl max-w-lg w-full max-h-[90vh] overflow-auto">
                {children}
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════
// KEY REVEAL COMPONENT (one-time display)
// ═══════════════════════════════════════════════

function KeyReveal({
    label, apiKey, onDismiss,
}: {
    label: string;
    apiKey: string;
    onDismiss: () => void;
}) {
    const [copied, setCopied] = useState(false);
    const [visible, setVisible] = useState(false);

    const handleCopy = async () => {
        await navigator.clipboard.writeText(apiKey);
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
    };

    const masked = apiKey.slice(0, 12) + "•".repeat(Math.max(0, apiKey.length - 16)) + apiKey.slice(-4);

    return (
        <div className="p-6">
            <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-xl bg-emerald-50 flex items-center justify-center">
                    <Key className="h-5 w-5 text-emerald-600" />
                </div>
                <div>
                    <h3 className="text-base font-bold text-foreground">{label}</h3>
                    <p className="text-xs text-muted-foreground">Your API key has been created</p>
                </div>
            </div>

            {/* Warning banner */}
            <div className="flex items-start gap-2.5 px-4 py-3 rounded-lg bg-amber-50 border border-amber-200 mb-5">
                <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                <div>
                    <p className="text-sm font-bold text-amber-800">Save this key now</p>
                    <p className="text-xs text-amber-700 mt-0.5">
                        This key will <span className="font-bold">NOT</span> be shown again. Store it securely.
                    </p>
                </div>
            </div>

            {/* Key display */}
            <div className="bg-muted/50 rounded-xl border border-border p-4">
                <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">API Key</span>
                    <button
                        onClick={() => setVisible(!visible)}
                        className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
                    >
                        {visible ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                        {visible ? "Hide" : "Reveal"}
                    </button>
                </div>
                <div className="flex items-center gap-2">
                    <code className="flex-1 text-sm font-mono text-foreground bg-card rounded-lg border border-border px-3 py-2.5 break-all select-all">
                        {visible ? apiKey : masked}
                    </code>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={handleCopy}
                        className={`shrink-0 h-10 px-3 ${copied ? "border-emerald-300 text-emerald-600" : ""}`}
                    >
                        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    </Button>
                </div>
            </div>

            <div className="mt-5 flex justify-end">
                <Button onClick={onDismiss} className="font-bold text-sm h-10 px-6">
                    Done — I&apos;ve saved it
                </Button>
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════

export default function ApiKeysPage() {
    const router = useRouter();
    const { token, logout, isLoading: authLoading } = useAuth();

    // Data
    const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Create form
    const [showCreate, setShowCreate] = useState(false);
    const [createName, setCreateName] = useState("Default Key");
    const [createRpm, setCreateRpm] = useState(60);
    const [createDailyTokens, setCreateDailyTokens] = useState(1000000);
    const [creating, setCreating] = useState(false);

    // Key reveal modal
    const [revealKey, setRevealKey] = useState<{ label: string; key: string } | null>(null);

    // Confirm modal
    const [confirmAction, setConfirmAction] = useState<{
        type: "finalize" | "revoke";
        keyId: string;
        keyName: string;
    } | null>(null);
    const [confirming, setConfirming] = useState(false);

    // Action loading
    const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);

    // Toast
    const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);

    const showToast = useCallback((message: string, type: "success" | "error") => {
        setToast({ message, type });
        setTimeout(() => setToast(null), 4000);
    }, []);

    // ─── Load ───

    const loadKeys = useCallback(async () => {
        if (!token) return;
        setLoading(true);
        setError(null);
        try {
            const data = await apiKeyApi.list(token);
            setKeys(data);
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
        if (token) loadKeys();
    }, [token, authLoading, router, loadKeys]);

    // ─── Create ───

    const handleCreate = async () => {
        if (!token) return;
        setCreating(true);
        try {
            const res = await apiKeyApi.create(token, {
                name: createName,
                rpm_limit: createRpm,
                daily_token_limit: createDailyTokens,
            });
            setRevealKey({ label: res.name, key: res.key });
            setShowCreate(false);
            setCreateName("Default Key");
            setCreateRpm(60);
            setCreateDailyTokens(1000000);
            await loadKeys();
        } catch (err) {
            if (err instanceof ApiRequestError) showToast(err.data.detail, "error");
            else showToast("Failed to create key", "error");
        } finally {
            setCreating(false);
        }
    };

    // ─── Rotate ───

    const handleRotate = async (keyId: string) => {
        if (!token) return;
        setActionLoadingId(keyId);
        try {
            const res = await apiKeyApi.rotate(token, keyId);
            setRevealKey({ label: "Rotated Key (NEXT)", key: res.new_key });
            await loadKeys();
            showToast("Key rotated — both keys active during grace period", "success");
        } catch (err) {
            if (err instanceof ApiRequestError) showToast(err.data.detail, "error");
        } finally {
            setActionLoadingId(null);
        }
    };

    // ─── Finalize ───

    const handleFinalize = async (keyId: string) => {
        if (!token) return;
        setConfirming(true);
        try {
            await apiKeyApi.finalize(token, keyId);
            await loadKeys();
            showToast("Rotation finalized — old key retired", "success");
        } catch (err) {
            if (err instanceof ApiRequestError) showToast(err.data.detail, "error");
        } finally {
            setConfirming(false);
            setConfirmAction(null);
        }
    };

    // ─── Revoke ───

    const handleRevoke = async (keyId: string) => {
        if (!token) return;
        setConfirming(true);
        try {
            await apiKeyApi.revoke(token, keyId);
            await loadKeys();
            showToast("API key revoked immediately", "success");
        } catch (err) {
            if (err instanceof ApiRequestError) showToast(err.data.detail, "error");
        } finally {
            setConfirming(false);
            setConfirmAction(null);
        }
    };

    // ─── Derived ───

    const activeKeys = keys.filter((k) => k.status === "active");
    const nextKeys = keys.filter((k) => k.status === "next");
    const hasNextKey = nextKeys.length > 0;

    // ─── Render ───

    if (authLoading || loading) {
        return (
            <div className="min-h-screen bg-background flex items-center justify-center">
                <div className="flex flex-col items-center gap-3">
                    <RefreshCw className="h-6 w-6 text-primary animate-spin" />
                    <p className="text-sm text-muted-foreground font-medium">Loading API keys…</p>
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
                    <Button onClick={loadKeys} variant="outline">
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

            {/* Key Reveal Modal */}
            <Modal open={!!revealKey} onClose={() => setRevealKey(null)}>
                {revealKey && (
                    <KeyReveal
                        label={revealKey.label}
                        apiKey={revealKey.key}
                        onDismiss={() => setRevealKey(null)}
                    />
                )}
            </Modal>

            {/* Confirmation Modal */}
            <Modal open={!!confirmAction} onClose={() => !confirming && setConfirmAction(null)}>
                {confirmAction && (
                    <div className="p-6">
                        <div className="flex items-center gap-3 mb-5">
                            <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${confirmAction.type === "revoke" ? "bg-red-50" : "bg-amber-50"
                                }`}>
                                {confirmAction.type === "revoke" ? (
                                    <Trash2 className="h-5 w-5 text-red-600" />
                                ) : (
                                    <ArrowRightLeft className="h-5 w-5 text-amber-600" />
                                )}
                            </div>
                            <div>
                                <h3 className="text-base font-bold text-foreground">
                                    {confirmAction.type === "revoke" ? "Revoke API Key" : "Finalize Rotation"}
                                </h3>
                                <p className="text-xs text-muted-foreground">{confirmAction.keyName}</p>
                            </div>
                        </div>

                        {confirmAction.type === "revoke" ? (
                            <div className="flex items-start gap-2.5 px-4 py-3 rounded-lg bg-red-50 border border-red-200 mb-5">
                                <AlertTriangle className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
                                <div>
                                    <p className="text-sm font-bold text-red-800">Emergency Revoke</p>
                                    <p className="text-xs text-red-700 mt-0.5">
                                        This key will be <span className="font-bold">immediately invalidated</span>. Any application using it will lose access. This cannot be undone.
                                    </p>
                                </div>
                            </div>
                        ) : (
                            <div className="flex items-start gap-2.5 px-4 py-3 rounded-lg bg-amber-50 border border-amber-200 mb-5">
                                <Info className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                                <div>
                                    <p className="text-sm font-bold text-amber-800">Complete Rotation</p>
                                    <p className="text-xs text-amber-700 mt-0.5">
                                        The <span className="font-bold">NEXT</span> key will become <span className="font-bold">ACTIVE</span> and the old key will be <span className="font-bold">RETIRED</span>. Make sure you have updated your applications.
                                    </p>
                                </div>
                            </div>
                        )}

                        <div className="flex items-center gap-3 justify-end">
                            <Button variant="outline" onClick={() => setConfirmAction(null)} disabled={confirming} className="text-sm font-semibold">
                                Cancel
                            </Button>
                            <Button
                                onClick={() => {
                                    if (confirmAction.type === "revoke") handleRevoke(confirmAction.keyId);
                                    else handleFinalize(confirmAction.keyId);
                                }}
                                disabled={confirming}
                                className={`text-sm font-bold ${confirmAction.type === "revoke"
                                    ? "bg-red-600 hover:bg-red-700 text-white"
                                    : ""
                                    }`}
                            >
                                {confirming ? (
                                    <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                                ) : confirmAction.type === "revoke" ? (
                                    <Trash2 className="h-4 w-4 mr-2" />
                                ) : (
                                    <CheckCircle2 className="h-4 w-4 mr-2" />
                                )}
                                {confirmAction.type === "revoke" ? "Revoke Now" : "Finalize Rotation"}
                            </Button>
                        </div>
                    </div>
                )}
            </Modal>

            {/* Header */}
            <header className="sticky top-0 z-30 bg-card/80 backdrop-blur-md border-b border-border">
                <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center text-primary-foreground">
                            <LayoutGrid className="h-4 w-4" />
                        </div>
                        <span className="font-bold text-foreground text-sm tracking-tight">Enterprise AI Platform</span>
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        <span className="font-semibold text-foreground text-sm">API Keys</span>
                    </div>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={async () => { await logout(); router.push("/login"); }}
                        className="text-xs font-semibold"
                    >
                        <LogOut className="h-3.5 w-3.5 mr-1.5" />
                        Sign Out
                    </Button>
                </div>
            </header>

            <main className="max-w-6xl mx-auto px-6 py-8 space-y-8">

                {/* ═══ INFO BAR (when NEXT key exists) ═══ */}
                {hasNextKey && (
                    <div className="flex items-start gap-3 px-5 py-4 rounded-xl bg-blue-50 border border-blue-200">
                        <ArrowRightLeft className="h-5 w-5 text-blue-600 shrink-0 mt-0.5" />
                        <div>
                            <p className="text-sm font-bold text-blue-800">Rotation in progress</p>
                            <p className="text-xs text-blue-700 mt-0.5">
                                You have <span className="font-bold">2 active keys</span> (ACTIVE + NEXT). Both work during the grace period.
                                When ready, click <span className="font-bold">Finalize</span> on the old key to complete rotation.
                            </p>
                        </div>
                    </div>
                )}

                {/* ═══ CREATE KEY SECTION ═══ */}
                <section>
                    <div className="flex items-center justify-between mb-5">
                        <div className="flex items-center gap-2.5">
                            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                                <Key className="h-4 w-4 text-primary" />
                            </div>
                            <div>
                                <h2 className="text-lg font-bold text-foreground">API Keys</h2>
                                <p className="text-xs text-muted-foreground">
                                    Manage keys for programmatic access to the platform
                                </p>
                            </div>
                        </div>
                        <Button
                            onClick={() => setShowCreate(!showCreate)}
                            className="font-bold text-sm h-10 shadow-sm"
                        >
                            <Plus className="h-4 w-4 mr-1.5" />
                            Create Key
                        </Button>
                    </div>

                    {/* Create form (inline) */}
                    {showCreate && (
                        <div className="bg-card rounded-2xl border border-border shadow-sm p-6 mb-6 animate-in slide-in-from-top-1 fade-in duration-200">
                            <div className="flex items-end gap-4">
                                <div className="flex-1 max-w-sm">
                                    <Label htmlFor="key-name" className="text-sm font-semibold mb-1.5 block">
                                        Key Name
                                    </Label>
                                    <Input
                                        id="key-name"
                                        value={createName}
                                        onChange={(e) => setCreateName(e.target.value)}
                                        placeholder="e.g. Production App"
                                        className="h-11"
                                        autoFocus
                                    />
                                </div>
                                <div className="w-32">
                                    <Label htmlFor="key-rpm" className="text-sm font-semibold mb-1.5 block">
                                        RPM Limit
                                    </Label>
                                    <Input
                                        id="key-rpm"
                                        type="number"
                                        value={createRpm}
                                        onChange={(e) => setCreateRpm(Number(e.target.value))}
                                        min={1}
                                        max={1000}
                                        className="h-11"
                                    />
                                </div>
                                <div className="w-44">
                                    <Label htmlFor="key-tokens" className="text-sm font-semibold mb-1.5 block">
                                        Daily Token Limit
                                    </Label>
                                    <Input
                                        id="key-tokens"
                                        type="number"
                                        value={createDailyTokens}
                                        onChange={(e) => setCreateDailyTokens(Number(e.target.value))}
                                        min={1000}
                                        step={100000}
                                        className="h-11"
                                    />
                                </div>
                                <Button
                                    onClick={handleCreate}
                                    disabled={creating || !createName.trim()}
                                    className="h-11 px-6 font-bold text-sm shadow-sm"
                                >
                                    {creating ? (
                                        <>
                                            <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                                            Creating…
                                        </>
                                    ) : (
                                        <>
                                            <Key className="h-4 w-4 mr-2" />
                                            Generate Key
                                        </>
                                    )}
                                </Button>
                                <Button
                                    variant="outline"
                                    onClick={() => setShowCreate(false)}
                                    className="h-11 px-4 text-sm"
                                >
                                    <X className="h-4 w-4" />
                                </Button>
                            </div>
                        </div>
                    )}
                </section>

                {/* ═══ KEYS TABLE ═══ */}
                <section>
                    <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
                        {/* Table header */}
                        <div className="hidden lg:grid grid-cols-12 gap-4 px-6 py-3 bg-muted/50 border-b border-border text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                            <div className="col-span-3">Key</div>
                            <div className="col-span-1">Status</div>
                            <div className="col-span-1">RPM</div>
                            <div className="col-span-2">Daily Token Usage</div>
                            <div className="col-span-2">Created</div>
                            <div className="col-span-3 text-right">Actions</div>
                        </div>

                        {keys.length === 0 ? (
                            <div className="px-6 py-16 text-center">
                                <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center mx-auto mb-4">
                                    <Key className="h-7 w-7 text-muted-foreground/40" />
                                </div>
                                <h3 className="text-base font-bold text-foreground mb-1.5">No API keys yet</h3>
                                <p className="text-sm text-muted-foreground mb-5 max-w-xs mx-auto">
                                    Create your first API key to start using the platform programmatically.
                                </p>
                                <Button onClick={() => setShowCreate(true)} className="font-bold text-sm shadow-sm">
                                    <Plus className="h-4 w-4 mr-1.5" />
                                    Create Your First Key
                                </Button>
                            </div>
                        ) : (
                            <div className="divide-y divide-border">
                                {keys.map((k) => {
                                    const style = STATUS_STYLES[k.status] || STATUS_STYLES.active;
                                    const isLoading = actionLoadingId === k.id;
                                    const isActive = k.status === "active";
                                    const isNext = k.status === "next";
                                    const canRotate = isActive && !hasNextKey;
                                    const canFinalize = isActive && hasNextKey;

                                    return (
                                        <div
                                            key={k.id}
                                            className={`grid grid-cols-1 lg:grid-cols-12 gap-3 lg:gap-4 px-6 py-5 items-center transition-colors hover:bg-muted/20 ${k.status === "retired" || k.status === "revoked" ? "opacity-50" : ""
                                                }`}
                                        >
                                            {/* Key info */}
                                            <div className="col-span-3">
                                                <div className="flex items-center gap-3">
                                                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${isActive ? "bg-emerald-50" : isNext ? "bg-blue-50" : "bg-muted"
                                                        }`}>
                                                        <Key className={`h-4 w-4 ${isActive ? "text-emerald-600" : isNext ? "text-blue-600" : "text-muted-foreground"
                                                            }`} />
                                                    </div>
                                                    <div className="min-w-0">
                                                        <p className="text-sm font-bold text-foreground truncate">{k.name}</p>
                                                        <p className="text-xs font-mono text-muted-foreground mt-0.5">{k.prefix}••••••</p>
                                                    </div>
                                                </div>
                                            </div>

                                            {/* Status */}
                                            <div className="col-span-1">
                                                <span className={`inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-full ${style.bg} ${style.text}`}>
                                                    <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
                                                    {k.status}
                                                </span>
                                            </div>

                                            {/* RPM */}
                                            <div className="col-span-1">
                                                <div className="flex items-center gap-1.5">
                                                    <Zap className="h-3 w-3 text-muted-foreground" />
                                                    <span className="text-sm text-foreground font-medium">{formatNumber(k.rpm_limit)}</span>
                                                </div>
                                            </div>

                                            {/* Daily Token Usage */}
                                            <div className="col-span-2">
                                                {(() => {
                                                    const used = k.daily_tokens_used ?? 0;
                                                    const limit = k.daily_token_limit ?? 1000000;
                                                    const pct = Math.min((used / limit) * 100, 100);
                                                    const color = pct >= 80 ? "bg-red-500" : pct >= 50 ? "bg-yellow-500" : "bg-emerald-500";
                                                    return (
                                                        <div className="space-y-1">
                                                            <div className="flex items-center justify-between text-[11px]">
                                                                <span className="font-medium text-foreground">{formatNumber(used)} / {formatNumber(limit)}</span>
                                                                <span className={`font-bold ${pct >= 80 ? "text-red-600" : pct >= 50 ? "text-yellow-600" : "text-emerald-600"}`}>{pct.toFixed(0)}%</span>
                                                            </div>
                                                            <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
                                                                <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
                                                            </div>
                                                        </div>
                                                    );
                                                })()}
                                            </div>

                                            {/* Created / Rotated */}
                                            <div className="col-span-2">
                                                <div className="flex items-center gap-1.5">
                                                    <Clock className="h-3 w-3 text-muted-foreground" />
                                                    <span className="text-sm text-muted-foreground">{formatDate(k.created_at)}</span>
                                                </div>
                                                {k.rotated_at && (
                                                    <div className="flex items-center gap-1.5 mt-1">
                                                        <RotateCw className="h-3 w-3 text-blue-500" />
                                                        <span className="text-xs text-blue-600 font-medium">Rotated {formatDate(k.rotated_at)}</span>
                                                    </div>
                                                )}
                                            </div>

                                            {/* Actions */}
                                            <div className="col-span-3 flex items-center gap-2 justify-end">
                                                {canRotate && (
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() => handleRotate(k.id)}
                                                        disabled={isLoading}
                                                        className="text-xs font-semibold"
                                                    >
                                                        {isLoading ? (
                                                            <RefreshCw className="h-3 w-3 animate-spin mr-1" />
                                                        ) : (
                                                            <RotateCw className="h-3 w-3 mr-1" />
                                                        )}
                                                        Rotate
                                                    </Button>
                                                )}

                                                {canFinalize && (
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() =>
                                                            setConfirmAction({ type: "finalize", keyId: k.id, keyName: k.name })
                                                        }
                                                        className="text-xs font-semibold border-blue-200 text-blue-700 hover:bg-blue-50"
                                                    >
                                                        <ArrowRightLeft className="h-3 w-3 mr-1" />
                                                        Finalize
                                                    </Button>
                                                )}

                                                {(isActive || isNext) && (
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() =>
                                                            setConfirmAction({ type: "revoke", keyId: k.id, keyName: k.name })
                                                        }
                                                        className="text-xs font-semibold text-destructive border-destructive/20 hover:bg-destructive/5"
                                                    >
                                                        <Trash2 className="h-3 w-3 mr-1" />
                                                        Revoke
                                                    </Button>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </section>

                {/* ═══ GOVERNANCE INFO ═══ */}
                <section className="pb-12">
                    <div className="bg-card rounded-2xl border border-border shadow-sm p-8">
                        <div className="flex items-center gap-2.5 mb-5">
                            <div className="w-8 h-8 rounded-lg bg-violet-500/10 flex items-center justify-center">
                                <Shield className="h-4 w-4 text-violet-600" />
                            </div>
                            <h2 className="text-lg font-bold text-foreground">Key Governance</h2>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                            {/* Rotation */}
                            <div className="bg-muted/30 rounded-xl border border-border/50 p-5">
                                <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center mb-3">
                                    <RotateCw className="h-4 w-4 text-blue-600" />
                                </div>
                                <h3 className="text-sm font-bold text-foreground mb-1">Zero-Downtime Rotation</h3>
                                <p className="text-xs text-muted-foreground leading-relaxed">
                                    Rotate creates a <span className="font-bold">NEXT</span> key while the old stays <span className="font-bold">ACTIVE</span>.
                                    Both work simultaneously during the grace period. Finalize when ready.
                                </p>
                            </div>

                            {/* Rate Limits */}
                            <div className="bg-muted/30 rounded-xl border border-border/50 p-5">
                                <div className="w-8 h-8 rounded-lg bg-amber-50 flex items-center justify-center mb-3">
                                    <Zap className="h-4 w-4 text-amber-600" />
                                </div>
                                <h3 className="text-sm font-bold text-foreground mb-1">Per-Key Rate Limits</h3>
                                <p className="text-xs text-muted-foreground leading-relaxed">
                                    Each key has independent <span className="font-bold">RPM</span> (requests per minute) and <span className="font-bold">daily token</span> budgets
                                    enforced at the gateway.
                                </p>
                            </div>

                            {/* Emergency Revoke */}
                            <div className="bg-muted/30 rounded-xl border border-border/50 p-5">
                                <div className="w-8 h-8 rounded-lg bg-red-50 flex items-center justify-center mb-3">
                                    <Trash2 className="h-4 w-4 text-red-600" />
                                </div>
                                <h3 className="text-sm font-bold text-foreground mb-1">Emergency Revoke</h3>
                                <p className="text-xs text-muted-foreground leading-relaxed">
                                    Instantly invalidate a compromised key. Takes effect <span className="font-bold">immediately</span> — no grace period.
                                    The key is evicted from Redis cache.
                                </p>
                            </div>
                        </div>
                    </div>
                </section>
            </main>
        </div>
    );
}
