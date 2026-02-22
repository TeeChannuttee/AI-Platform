"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
    Brain,
    Plus,
    Trash2,
    Save,
    RefreshCw,
    AlertTriangle,
    CheckCircle2,
    XCircle,
    ChevronRight,
    LayoutGrid,
    LogOut,
    X,
    Key,
    ShieldAlert,
    Info,
    Sparkles,
    Edit3,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { memoryApi, ApiRequestError } from "@/lib/api";
import type { MemoryItem } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// ─── Helpers ───

function formatDate(iso?: string): string {
    if (!iso) return "—";
    const utcIso = iso.includes("Z") || iso.includes("+") ? iso : iso + "Z";
    return new Date(utcIso).toLocaleDateString("en-US", {
        year: "numeric", month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit",
    });
}

// ═══════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════

export default function MemoryPage() {
    const router = useRouter();
    const { token, logout, isLoading: authLoading } = useAuth();

    const [memories, setMemories] = useState<MemoryItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Form
    const [formKey, setFormKey] = useState("");
    const [formValue, setFormValue] = useState("");
    const [formCategory, setFormCategory] = useState("preference");
    const [saving, setSaving] = useState(false);
    const [editingKey, setEditingKey] = useState<string | null>(null);

    // Deleting
    const [deletingKey, setDeletingKey] = useState<string | null>(null);

    // Purge
    const [confirmPurge, setConfirmPurge] = useState(false);
    const [purgeConfirmText, setPurgeConfirmText] = useState("");
    const [purging, setPurging] = useState(false);

    // Toast
    const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
    const showToast = useCallback((m: string, t: "success" | "error") => {
        setToast({ message: m, type: t });
        setTimeout(() => setToast(null), 4000);
    }, []);

    // ─── Load ───

    const loadMemories = useCallback(async () => {
        if (!token) return;
        setLoading(true);
        setError(null);
        try {
            const data = await memoryApi.list(token);
            setMemories(data);
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
        if (token) loadMemories();
    }, [token, authLoading, router, loadMemories]);

    // ─── Save ───

    const handleSave = async () => {
        if (!token || !formKey.trim() || !formValue.trim()) return;
        setSaving(true);
        try {
            await memoryApi.set(token, {
                key: formKey.trim(),
                value: formValue.trim(),
                category: formCategory,
            });
            showToast(editingKey ? "Memory updated" : "Memory saved", "success");
            setFormKey("");
            setFormValue("");
            setFormCategory("preference");
            setEditingKey(null);
            await loadMemories();
        } catch (err) {
            if (err instanceof ApiRequestError) showToast(err.data.detail, "error");
        } finally {
            setSaving(false);
        }
    };

    // ─── Delete ───

    const handleDelete = async (key: string) => {
        if (!token) return;
        setDeletingKey(key);
        try {
            await memoryApi.delete(token, key);
            setMemories((prev) => prev.filter((m) => m.key !== key));
            showToast("Memory deleted", "success");
        } catch (err) {
            if (err instanceof ApiRequestError) showToast(err.data.detail, "error");
        } finally {
            setDeletingKey(null);
        }
    };

    // ─── Edit ───

    const handleEdit = (mem: MemoryItem) => {
        setFormKey(mem.key);
        setFormValue(mem.value);
        setFormCategory(mem.category || "preference");
        setEditingKey(mem.key);
        window.scrollTo({ top: 0, behavior: "smooth" });
    };

    // ─── Purge ───

    const handlePurge = async () => {
        if (!token) return;
        setPurging(true);
        try {
            await memoryApi.purge(token);
            setMemories([]);
            showToast("All memory purged", "success");
        } catch (err) {
            if (err instanceof ApiRequestError) showToast(err.data.detail, "error");
        } finally {
            setPurging(false);
            setConfirmPurge(false);
            setPurgeConfirmText("");
        }
    };

    // ─── Render ───

    if (authLoading || loading) {
        return (
            <div className="min-h-screen bg-background flex items-center justify-center">
                <div className="flex flex-col items-center gap-3">
                    <RefreshCw className="h-6 w-6 text-primary animate-spin" />
                    <p className="text-sm text-muted-foreground font-medium">Loading memory…</p>
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
                    <Button onClick={loadMemories} variant="outline">
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

            {/* Purge Confirmation */}
            {confirmPurge && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={() => !purging && setConfirmPurge(false)} />
                    <div className="relative bg-card rounded-2xl border border-red-200 shadow-2xl max-w-sm w-full p-6">
                        <div className="flex items-center gap-3 mb-4">
                            <div className="w-10 h-10 rounded-xl bg-red-50 flex items-center justify-center">
                                <ShieldAlert className="h-5 w-5 text-red-600" />
                            </div>
                            <div>
                                <h3 className="text-base font-bold text-foreground">Purge All Memory</h3>
                                <p className="text-xs text-red-600 font-medium">This action is irreversible</p>
                            </div>
                        </div>
                        <p className="text-sm text-muted-foreground mb-4">
                            This will permanently delete <strong>all</strong> your semantic memories, episodic memories, and working memory. The AI will no longer remember any of your preferences.
                        </p>
                        <div className="mb-4">
                            <Label className="text-xs font-semibold text-muted-foreground">
                                Type <span className="font-bold text-red-600">PURGE</span> to confirm
                            </Label>
                            <Input
                                value={purgeConfirmText}
                                onChange={(e) => setPurgeConfirmText(e.target.value)}
                                placeholder="PURGE"
                                className="mt-1.5 text-sm border-red-200 focus:border-red-400"
                            />
                        </div>
                        <div className="flex items-center gap-3 justify-end">
                            <Button variant="outline" onClick={() => { setConfirmPurge(false); setPurgeConfirmText(""); }} disabled={purging} className="text-sm font-semibold">
                                Cancel
                            </Button>
                            <Button
                                onClick={handlePurge}
                                disabled={purging || purgeConfirmText !== "PURGE"}
                                className="text-sm font-bold bg-red-600 hover:bg-red-700 text-white disabled:opacity-40"
                            >
                                {purging ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <Trash2 className="h-4 w-4 mr-2" />}
                                Purge All
                            </Button>
                        </div>
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
                        <span className="font-semibold text-foreground text-sm">Memory Center</span>
                    </div>
                    <Button
                        variant="outline" size="sm"
                        onClick={async () => { await logout(); router.push("/login"); }}
                        className="text-xs font-semibold"
                    >
                        <LogOut className="h-3.5 w-3.5 mr-1.5" /> Sign Out
                    </Button>
                </div>
            </header>

            <main className="max-w-6xl mx-auto px-6 py-8 space-y-8">

                {/* ═══ TRANSPARENCY NOTE ═══ */}
                <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-blue-50 border border-blue-200">
                    <Info className="h-4 w-4 text-blue-600 shrink-0 mt-0.5" />
                    <div>
                        <p className="text-sm font-semibold text-blue-800">About AI Memory</p>
                        <p className="text-xs text-blue-700 mt-0.5">
                            These preferences are used by the AI assistant to personalize responses. Sensitive values are automatically sanitized by the backend. You can view, edit, or delete any memory at any time for full transparency.
                        </p>
                    </div>
                </div>

                {/* ═══ ADD / UPDATE FORM ═══ */}
                <section>
                    <div className="bg-card rounded-2xl border border-border shadow-sm p-6">
                        <div className="flex items-center gap-2.5 mb-5">
                            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                                {editingKey ? <Edit3 className="h-4 w-4 text-primary" /> : <Plus className="h-4 w-4 text-primary" />}
                            </div>
                            <div>
                                <h2 className="text-base font-bold text-foreground">
                                    {editingKey ? "Update Preference" : "Add Preference"}
                                </h2>
                                <p className="text-xs text-muted-foreground">
                                    {editingKey ? `Editing: "${editingKey}"` : "Store a setting the AI assistant should remember"}
                                </p>
                            </div>
                            {editingKey && (
                                <button
                                    onClick={() => { setEditingKey(null); setFormKey(""); setFormValue(""); setFormCategory("preference"); }}
                                    className="ml-auto p-1.5 rounded-lg hover:bg-muted transition-colors"
                                >
                                    <X className="h-4 w-4 text-muted-foreground" />
                                </button>
                            )}
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div>
                                <Label className="text-xs font-semibold text-muted-foreground">Key</Label>
                                <Input
                                    value={formKey}
                                    onChange={(e) => setFormKey(e.target.value)}
                                    placeholder="e.g. preferred_language"
                                    disabled={!!editingKey}
                                    className="mt-1 text-sm"
                                />
                            </div>
                            <div className="md:col-span-2">
                                <Label className="text-xs font-semibold text-muted-foreground">Value</Label>
                                <Input
                                    value={formValue}
                                    onChange={(e) => setFormValue(e.target.value)}
                                    placeholder="e.g. Thai"
                                    className="mt-1 text-sm"
                                />
                            </div>
                        </div>

                        <div className="flex items-center gap-3 mt-4">
                            <select
                                value={formCategory}
                                onChange={(e) => setFormCategory(e.target.value)}
                                className="h-9 rounded-lg border border-border bg-background px-3 text-xs font-medium text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
                            >
                                <option value="preference">Preference</option>
                                <option value="context">Context</option>
                                <option value="instruction">Instruction</option>
                            </select>
                            <Button
                                onClick={handleSave}
                                disabled={saving || !formKey.trim() || !formValue.trim()}
                                className="text-xs font-bold shadow-sm"
                            >
                                {saving ? <RefreshCw className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
                                {editingKey ? "Update" : "Save"}
                            </Button>
                        </div>
                    </div>
                </section>

                {/* ═══ MEMORY LIST ═══ */}
                <section>
                    <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-2.5">
                            <div className="w-8 h-8 rounded-lg bg-violet-500/10 flex items-center justify-center">
                                <Brain className="h-4 w-4 text-violet-600" />
                            </div>
                            <div>
                                <h2 className="text-lg font-bold text-foreground">Stored Memories</h2>
                                <p className="text-xs text-muted-foreground">
                                    {memories.length} memor{memories.length !== 1 ? "ies" : "y"}
                                </p>
                            </div>
                        </div>
                        <Button variant="outline" size="sm" onClick={loadMemories} className="text-xs font-semibold">
                            <RefreshCw className="h-3 w-3 mr-1" /> Refresh
                        </Button>
                    </div>

                    <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
                        {/* Table header */}
                        <div className="hidden lg:grid grid-cols-12 gap-4 px-6 py-3 bg-muted/50 border-b border-border text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                            <div className="col-span-3">Key</div>
                            <div className="col-span-4">Value</div>
                            <div className="col-span-1">Category</div>
                            <div className="col-span-2">Updated</div>
                            <div className="col-span-2 text-right">Actions</div>
                        </div>

                        {memories.length === 0 ? (
                            <div className="px-6 py-16 text-center">
                                <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center mx-auto mb-4">
                                    <Sparkles className="h-7 w-7 text-muted-foreground/40" />
                                </div>
                                <h3 className="text-base font-bold text-foreground mb-1.5">No memories stored</h3>
                                <p className="text-sm text-muted-foreground mb-5 max-w-xs mx-auto">
                                    Add preferences above so the AI assistant can personalize its responses.
                                </p>
                            </div>
                        ) : (
                            <div className="divide-y divide-border">
                                {memories.map((mem) => {
                                    const categoryColors: Record<string, string> = {
                                        preference: "bg-blue-50 text-blue-700",
                                        context: "bg-amber-50 text-amber-700",
                                        instruction: "bg-violet-50 text-violet-700",
                                    };
                                    const catClass = categoryColors[mem.category] || "bg-muted text-muted-foreground";

                                    return (
                                        <div
                                            key={mem.key}
                                            className="grid grid-cols-1 lg:grid-cols-12 gap-3 lg:gap-4 px-6 py-4 items-center hover:bg-muted/20 transition-colors"
                                        >
                                            {/* Key */}
                                            <div className="col-span-3">
                                                <div className="flex items-center gap-2">
                                                    <Key className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                                    <span className="text-sm font-bold text-foreground font-mono">{mem.key}</span>
                                                </div>
                                            </div>

                                            {/* Value */}
                                            <div className="col-span-4">
                                                <p className="text-sm text-muted-foreground line-clamp-2">{mem.value}</p>
                                            </div>

                                            {/* Category */}
                                            <div className="col-span-1">
                                                <span className={`inline-flex text-[10px] font-bold px-2 py-0.5 rounded-full uppercase ${catClass}`}>
                                                    {mem.category}
                                                </span>
                                            </div>

                                            {/* Updated */}
                                            <div className="col-span-2">
                                                <span className="text-xs text-muted-foreground">{formatDate(mem.updated_at || mem.created_at)}</span>
                                            </div>

                                            {/* Actions */}
                                            <div className="col-span-2 flex items-center gap-1.5 justify-end">
                                                <Button
                                                    variant="outline" size="sm"
                                                    onClick={() => handleEdit(mem)}
                                                    className="text-xs font-semibold"
                                                >
                                                    <Edit3 className="h-3 w-3 mr-1" /> Edit
                                                </Button>
                                                <Button
                                                    variant="outline" size="sm"
                                                    onClick={() => handleDelete(mem.key)}
                                                    disabled={deletingKey === mem.key}
                                                    className="text-xs font-semibold text-destructive border-destructive/20 hover:bg-destructive/5"
                                                >
                                                    {deletingKey === mem.key ? (
                                                        <RefreshCw className="h-3 w-3 animate-spin" />
                                                    ) : (
                                                        <Trash2 className="h-3 w-3" />
                                                    )}
                                                </Button>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </section>

                {/* ═══ DANGER ZONE ═══ */}
                <section className="pb-12">
                    <div className="bg-card rounded-2xl border-2 border-red-200 shadow-sm p-6">
                        <div className="flex items-center gap-2.5 mb-4">
                            <div className="w-8 h-8 rounded-lg bg-red-50 flex items-center justify-center">
                                <ShieldAlert className="h-4 w-4 text-red-600" />
                            </div>
                            <div>
                                <h2 className="text-base font-bold text-red-800">Danger Zone</h2>
                                <p className="text-xs text-red-600">Irreversible actions</p>
                            </div>
                        </div>
                        <p className="text-sm text-muted-foreground mb-4">
                            Purging all memory will permanently delete all stored preferences, episodic memories, and working memory.
                            The AI assistant will start fresh with no knowledge of your preferences.
                        </p>
                        <Button
                            onClick={() => setConfirmPurge(true)}
                            disabled={memories.length === 0}
                            className="text-xs font-bold bg-red-600 hover:bg-red-700 text-white"
                        >
                            <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Purge All Memory
                        </Button>
                    </div>
                </section>
            </main>
        </div>
    );
}
