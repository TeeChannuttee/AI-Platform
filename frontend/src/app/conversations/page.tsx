"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
    MessageSquare,
    Search,
    Trash2,
    RefreshCw,
    AlertTriangle,
    CheckCircle2,
    XCircle,
    ChevronRight,
    LayoutGrid,
    LogOut,
    Clock,
    ArrowRight,
    MessagesSquare,
    X,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { llmApi, ApiRequestError } from "@/lib/api";
import type { ConversationItem } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// ─── Helpers ───

function formatDate(iso: string | null): string {
    if (!iso) return "—";
    const utcIso = iso.includes("Z") || iso.includes("+") ? iso : iso + "Z";
    return new Date(utcIso).toLocaleDateString("en-US", {
        year: "numeric", month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit",
    });
}

function relativeTime(iso: string | null): string {
    if (!iso) return "";
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60000) return "Just now";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
    return formatDate(iso);
}

// ═══════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════

export default function ConversationsPage() {
    const router = useRouter();
    const { token, logout, isLoading: authLoading } = useAuth();

    const [conversations, setConversations] = useState<ConversationItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState("");

    // Delete
    const [confirmDelete, setConfirmDelete] = useState<{ id: string; title: string } | null>(null);
    const [deleting, setDeleting] = useState(false);

    // Toast
    const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
    const showToast = useCallback((m: string, t: "success" | "error") => {
        setToast({ message: m, type: t });
        setTimeout(() => setToast(null), 4000);
    }, []);

    // ─── Load ───

    const loadConversations = useCallback(async () => {
        if (!token) return;
        setLoading(true);
        setError(null);
        try {
            const data = await llmApi.listConversations(token);
            setConversations(data);
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
        if (token) loadConversations();
    }, [token, authLoading, router, loadConversations]);

    // ─── Delete ───

    const handleDelete = async (convId: string) => {
        if (!token) return;
        setDeleting(true);
        try {
            await llmApi.deleteConversation(token, convId);
            setConversations((prev) => prev.filter((c) => c.id !== convId));
            showToast("Conversation deleted", "success");
        } catch (err) {
            if (err instanceof ApiRequestError) showToast(err.data.detail, "error");
        } finally {
            setDeleting(false);
            setConfirmDelete(null);
        }
    };

    // ─── Filtered ───

    const filtered = useMemo(() => {
        if (!searchQuery.trim()) return conversations;
        const q = searchQuery.toLowerCase();
        return conversations.filter((c) => c.title.toLowerCase().includes(q));
    }, [conversations, searchQuery]);

    // ─── Render ───

    if (authLoading || loading) {
        return (
            <div className="min-h-screen bg-background flex items-center justify-center">
                <div className="flex flex-col items-center gap-3">
                    <RefreshCw className="h-6 w-6 text-primary animate-spin" />
                    <p className="text-sm text-muted-foreground font-medium">Loading conversations…</p>
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
                    <Button onClick={loadConversations} variant="outline">
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

            {/* Delete Confirmation */}
            {confirmDelete && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={() => !deleting && setConfirmDelete(null)} />
                    <div className="relative bg-card rounded-2xl border border-border shadow-2xl max-w-sm w-full p-6">
                        <div className="flex items-center gap-3 mb-4">
                            <div className="w-10 h-10 rounded-xl bg-red-50 flex items-center justify-center">
                                <Trash2 className="h-5 w-5 text-red-600" />
                            </div>
                            <div>
                                <h3 className="text-base font-bold text-foreground">Delete Conversation</h3>
                                <p className="text-xs text-muted-foreground truncate max-w-[220px]">{confirmDelete.title}</p>
                            </div>
                        </div>
                        <p className="text-sm text-muted-foreground mb-5">
                            This conversation and all its messages will be permanently deleted. Memory associated with this conversation will also be purged.
                        </p>
                        <div className="flex items-center gap-3 justify-end">
                            <Button variant="outline" onClick={() => setConfirmDelete(null)} disabled={deleting} className="text-sm font-semibold">
                                Cancel
                            </Button>
                            <Button
                                onClick={() => handleDelete(confirmDelete.id)}
                                disabled={deleting}
                                className="text-sm font-bold bg-red-600 hover:bg-red-700 text-white"
                            >
                                {deleting ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <Trash2 className="h-4 w-4 mr-2" />}
                                Delete
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
                        <span className="font-semibold text-foreground text-sm">Conversations</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button
                            onClick={() => router.push("/chat")}
                            className="text-xs font-bold h-9 shadow-sm"
                        >
                            <MessageSquare className="h-3.5 w-3.5 mr-1.5" /> New Chat
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

            <main className="max-w-6xl mx-auto px-6 py-8">
                {/* Title + Search */}
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
                    <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-lg bg-violet-500/10 flex items-center justify-center">
                            <MessagesSquare className="h-4 w-4 text-violet-600" />
                        </div>
                        <div>
                            <h2 className="text-lg font-bold text-foreground">Conversation History</h2>
                            <p className="text-xs text-muted-foreground">
                                {conversations.length} conversation{conversations.length !== 1 ? "s" : ""}
                            </p>
                        </div>
                    </div>

                    <div className="relative w-full sm:w-72">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder="Search conversations…"
                            className="pl-9 h-10 text-sm"
                        />
                        {searchQuery && (
                            <button
                                onClick={() => setSearchQuery("")}
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                            >
                                <X className="h-3.5 w-3.5" />
                            </button>
                        )}
                    </div>
                </div>

                {/* Conversations List */}
                <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
                    {filtered.length === 0 ? (
                        <div className="px-6 py-16 text-center">
                            <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center mx-auto mb-4">
                                <MessagesSquare className="h-7 w-7 text-muted-foreground/40" />
                            </div>
                            <h3 className="text-base font-bold text-foreground mb-1.5">
                                {searchQuery ? "No matching conversations" : "No conversations yet"}
                            </h3>
                            <p className="text-sm text-muted-foreground mb-5 max-w-xs mx-auto">
                                {searchQuery
                                    ? `No conversations match "${searchQuery}". Try a different search.`
                                    : "Start a new chat with the AI assistant to create your first conversation."}
                            </p>
                            {!searchQuery && (
                                <Button onClick={() => router.push("/chat")} className="font-bold text-sm shadow-sm">
                                    <MessageSquare className="h-4 w-4 mr-1.5" /> Start a Chat
                                </Button>
                            )}
                        </div>
                    ) : (
                        <div className="divide-y divide-border">
                            {filtered.map((conv) => (
                                <div
                                    key={conv.id}
                                    className="group flex items-center gap-4 px-6 py-4 hover:bg-muted/20 transition-colors cursor-pointer"
                                    onClick={() => router.push(`/conversations/${conv.id}`)}
                                >
                                    {/* Icon */}
                                    <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                                        <MessageSquare className="h-5 w-5 text-primary" />
                                    </div>

                                    {/* Content */}
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-bold text-foreground truncate group-hover:text-primary transition-colors">
                                            {conv.title}
                                        </p>
                                        <div className="flex items-center gap-3 mt-1">
                                            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                                                <Clock className="h-3 w-3" />
                                                {relativeTime(conv.updated_at)}
                                            </span>
                                            <span className="text-xs text-muted-foreground">
                                                Created {formatDate(conv.created_at)}
                                            </span>
                                        </div>
                                    </div>

                                    {/* Actions */}
                                    <div className="flex items-center gap-2 shrink-0">
                                        <Button
                                            variant="outline" size="sm"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setConfirmDelete({ id: conv.id, title: conv.title });
                                            }}
                                            className="opacity-0 group-hover:opacity-100 transition-opacity text-xs text-destructive border-destructive/20 hover:bg-destructive/5"
                                        >
                                            <Trash2 className="h-3 w-3" />
                                        </Button>
                                        <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </main>
        </div>
    );
}
