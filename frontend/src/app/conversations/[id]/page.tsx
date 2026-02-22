"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useRouter, useParams } from "next/navigation";
import {
    MessageSquare,
    Trash2,
    RefreshCw,
    AlertTriangle,
    CheckCircle2,
    XCircle,
    ChevronRight,
    LayoutGrid,
    LogOut,
    Clock,
    ArrowLeft,
    Zap,
    BookOpen,
    Bot,
    User,
    ExternalLink,
    Play,
    X,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { llmApi, ApiRequestError } from "@/lib/api";
import type { ChatMessage, Citation, ConversationDetail } from "@/lib/api";
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

function formatTokens(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return n.toString();
}

// ─── Markdown Renderer (shared logic) ───

function renderMarkdown(text: string): React.ReactNode {
    const lines = text.split("\n");
    const elements: React.ReactNode[] = [];
    let inCodeBlock = false;
    let codeLang = "";
    let codeLines: string[] = [];
    let tableRows: string[][] = [];
    let inTable = false;

    const flushTable = () => {
        if (tableRows.length > 0) {
            elements.push(
                <div key={`tbl-${elements.length}`} className="my-3 overflow-x-auto rounded-lg border border-border">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="bg-muted/50">
                                {tableRows[0].map((cell, ci) => (
                                    <th key={ci} className="px-3 py-2 text-left font-semibold text-foreground border-b border-border">{cell.trim()}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {tableRows.slice(2).map((row, ri) => (
                                <tr key={ri} className="border-b border-border last:border-0">
                                    {row.map((cell, ci) => (
                                        <td key={ci} className="px-3 py-2 text-muted-foreground">{cell.trim()}</td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            );
            tableRows = [];
            inTable = false;
        }
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (line.startsWith("```")) {
            if (inCodeBlock) {
                elements.push(
                    <div key={`code-${i}`} className="my-3 rounded-lg bg-[#1e1e2e] overflow-hidden">
                        <div className="flex items-center px-4 py-2 bg-[#181825] border-b border-[#313244]">
                            <span className="text-xs font-mono text-[#cdd6f4]/60">{codeLang || "code"}</span>
                        </div>
                        <pre className="p-4 overflow-x-auto text-sm"><code className="text-[#cdd6f4]">{codeLines.join("\n")}</code></pre>
                    </div>
                );
                codeLines = [];
                inCodeBlock = false;
                continue;
            }
            inCodeBlock = true;
            codeLang = line.slice(3).trim();
            continue;
        }
        if (inCodeBlock) { codeLines.push(line); continue; }

        if (line.includes("|") && line.trim().startsWith("|")) {
            const cells = line.split("|").filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
            if (!inTable) inTable = true;
            tableRows.push(cells);
            continue;
        } else { flushTable(); }

        if (line.startsWith("### ")) { elements.push(<h3 key={i} className="text-base font-bold text-foreground mt-4 mb-2">{line.slice(4)}</h3>); continue; }
        if (line.startsWith("## ")) { elements.push(<h2 key={i} className="text-lg font-bold text-foreground mt-4 mb-2">{line.slice(3)}</h2>); continue; }
        if (line.startsWith("# ")) { elements.push(<h1 key={i} className="text-xl font-bold text-foreground mt-4 mb-2">{line.slice(2)}</h1>); continue; }

        if (/^[\-\*] /.test(line)) {
            elements.push(
                <div key={i} className="flex items-start gap-2 ml-2 my-0.5">
                    <span className="text-primary mt-1.5 text-xs">•</span>
                    <span className="text-sm text-foreground leading-relaxed">{renderInline(line.slice(2))}</span>
                </div>
            );
            continue;
        }
        if (/^\d+\. /.test(line)) {
            const num = line.match(/^(\d+)\./)?.[1];
            elements.push(
                <div key={i} className="flex items-start gap-2 ml-2 my-0.5">
                    <span className="text-primary mt-0.5 text-xs font-bold min-w-[16px]">{num}.</span>
                    <span className="text-sm text-foreground leading-relaxed">{renderInline(line.replace(/^\d+\.\s*/, ""))}</span>
                </div>
            );
            continue;
        }

        if (line.trim() === "") { elements.push(<div key={i} className="h-2" />); continue; }
        elements.push(<p key={i} className="text-sm text-foreground leading-relaxed my-1">{renderInline(line)}</p>);
    }

    flushTable();
    return <>{elements}</>;
}

function renderInline(text: string): React.ReactNode {
    const parts: React.ReactNode[] = [];
    const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[citation:(\d+)\])/g;
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
        const m = match[0];
        if (m.startsWith("`") && m.endsWith("`")) {
            parts.push(<code key={match.index} className="px-1.5 py-0.5 bg-muted rounded text-xs font-mono text-foreground">{m.slice(1, -1)}</code>);
        } else if (m.startsWith("**") && m.endsWith("**")) {
            parts.push(<strong key={match.index} className="font-bold">{m.slice(2, -2)}</strong>);
        } else if (m.startsWith("*") && m.endsWith("*")) {
            parts.push(<em key={match.index}>{m.slice(1, -1)}</em>);
        } else if (m.startsWith("[citation:")) {
            const num = match[2];
            parts.push(
                <span key={match.index} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-primary/10 text-primary text-[10px] font-bold rounded-md mx-0.5">
                    <BookOpen className="h-2.5 w-2.5" />{num}
                </span>
            );
        }
        lastIndex = match.index + m.length;
    }
    if (lastIndex < text.length) parts.push(text.slice(lastIndex));
    return parts.length > 0 ? <>{parts}</> : text;
}

// ═══════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════

export default function ConversationDetailPage() {
    const router = useRouter();
    const params = useParams();
    const convId = params.id as string;
    const { token, logout, isLoading: authLoading } = useAuth();

    const [conversation, setConversation] = useState<ConversationDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Selected message for citation detail
    const [selectedMsgId, setSelectedMsgId] = useState<string | null>(null);

    // Delete
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [deleting, setDeleting] = useState(false);

    // Toast
    const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
    const showToast = useCallback((m: string, t: "success" | "error") => {
        setToast({ message: m, type: t });
        setTimeout(() => setToast(null), 4000);
    }, []);

    // ─── Load ───

    const loadConversation = useCallback(async () => {
        if (!token || !convId) return;
        setLoading(true);
        setError(null);
        try {
            const data = await llmApi.getConversation(token, convId);
            setConversation(data);
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
    }, [token, convId, logout, router]);

    useEffect(() => {
        if (!authLoading && !token) { router.push("/login"); return; }
        if (token) loadConversation();
    }, [token, authLoading, router, loadConversation]);

    // ─── Delete ───

    const handleDelete = async () => {
        if (!token) return;
        setDeleting(true);
        try {
            await llmApi.deleteConversation(token, convId);
            showToast("Conversation deleted", "success");
            setTimeout(() => router.push("/conversations"), 500);
        } catch (err) {
            if (err instanceof ApiRequestError) showToast(err.data.detail, "error");
            setDeleting(false);
            setConfirmDelete(false);
        }
    };

    // ─── Derived ───

    const selectedMsg = conversation?.messages.find((m) => m.id === selectedMsgId);
    const assistantMessages = conversation?.messages.filter((m) => m.role === "assistant") ?? [];

    // Total token usage
    const totalTokens = assistantMessages.reduce(
        (acc, m) => ({
            prompt: acc.prompt + (m.tokens?.prompt ?? 0),
            completion: acc.completion + (m.tokens?.completion ?? 0),
            total: acc.total + (m.tokens?.total ?? 0),
        }),
        { prompt: 0, completion: 0, total: 0 }
    );

    // Collect all unique file_ids from user messages
    const allFileIds = Array.from(
        new Set(
            conversation?.messages
                .filter((m) => m.file_ids && m.file_ids.length > 0)
                .flatMap((m) => m.file_ids!) ?? []
        )
    );

    // ─── Render ───

    if (authLoading || loading) {
        return (
            <div className="min-h-screen bg-background flex items-center justify-center">
                <div className="flex flex-col items-center gap-3">
                    <RefreshCw className="h-6 w-6 text-primary animate-spin" />
                    <p className="text-sm text-muted-foreground font-medium">Loading conversation…</p>
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
                    <div className="flex items-center gap-3 justify-center">
                        <Button variant="outline" onClick={() => router.push("/conversations")}>
                            <ArrowLeft className="h-4 w-4 mr-2" /> Back
                        </Button>
                        <Button variant="outline" onClick={loadConversation}>
                            <RefreshCw className="h-4 w-4 mr-2" /> Retry
                        </Button>
                    </div>
                </div>
            </div>
        );
    }

    if (!conversation) return null;

    return (
        <div className="h-screen bg-background flex flex-col">
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
                    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={() => !deleting && setConfirmDelete(false)} />
                    <div className="relative bg-card rounded-2xl border border-border shadow-2xl max-w-sm w-full p-6">
                        <div className="flex items-center gap-3 mb-4">
                            <div className="w-10 h-10 rounded-xl bg-red-50 flex items-center justify-center">
                                <Trash2 className="h-5 w-5 text-red-600" />
                            </div>
                            <div>
                                <h3 className="text-base font-bold text-foreground">Delete Conversation</h3>
                                <p className="text-xs text-muted-foreground truncate max-w-[220px]">{conversation.title}</p>
                            </div>
                        </div>
                        <p className="text-sm text-muted-foreground mb-5">
                            This conversation and all messages will be permanently deleted. Memory will also be purged.
                        </p>
                        <div className="flex items-center gap-3 justify-end">
                            <Button variant="outline" onClick={() => setConfirmDelete(false)} disabled={deleting} className="text-sm font-semibold">
                                Cancel
                            </Button>
                            <Button onClick={handleDelete} disabled={deleting} className="text-sm font-bold bg-red-600 hover:bg-red-700 text-white">
                                {deleting ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <Trash2 className="h-4 w-4 mr-2" />}
                                Delete
                            </Button>
                        </div>
                    </div>
                </div>
            )}

            {/* Header */}
            <header className="shrink-0 bg-card/80 backdrop-blur-md border-b border-border z-20">
                <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">
                    <div className="flex items-center gap-3 min-w-0">
                        <Button variant="outline" size="sm" onClick={() => router.push("/conversations")} className="shrink-0">
                            <ArrowLeft className="h-3.5 w-3.5" />
                        </Button>
                        <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center text-primary-foreground shrink-0">
                            <LayoutGrid className="h-3.5 w-3.5" />
                        </div>
                        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span className="text-sm text-muted-foreground shrink-0 cursor-pointer hover:text-foreground" onClick={() => router.push("/conversations")}>
                            Conversations
                        </span>
                        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span className="text-sm font-bold text-foreground truncate">{conversation.title}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        <Button
                            onClick={() => router.push(`/chat?conversation_id=${convId}`)}
                            className="text-xs font-bold h-8 shadow-sm"
                        >
                            <Play className="h-3.5 w-3.5 mr-1" /> Continue Chat
                        </Button>
                        <Button
                            variant="outline" size="sm"
                            onClick={() => setConfirmDelete(true)}
                            className="text-xs font-semibold text-destructive border-destructive/20 hover:bg-destructive/5"
                        >
                            <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                            variant="outline" size="sm"
                            onClick={async () => { await logout(); router.push("/login"); }}
                            className="text-xs font-semibold"
                        >
                            <LogOut className="h-3.5 w-3.5" />
                        </Button>
                    </div>
                </div>
            </header>

            {/* ═══ 2-PANE LAYOUT ═══ */}
            <div className="flex-1 flex overflow-hidden">

                {/* ─── LEFT: Message Thread ─── */}
                <main className="flex-1 overflow-y-auto">
                    <div className="max-w-3xl mx-auto px-6 py-6 space-y-5">
                        {/* Conversation meta */}
                        <div className="flex items-center gap-3 pb-4 border-b border-border">
                            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                                <MessageSquare className="h-5 w-5 text-primary" />
                            </div>
                            <div>
                                <h1 className="text-lg font-bold text-foreground">{conversation.title}</h1>
                                <p className="text-xs text-muted-foreground">
                                    {conversation.messages.length} message{conversation.messages.length !== 1 ? "s" : ""}
                                    {allFileIds.length > 0 && ` · ${allFileIds.length} file${allFileIds.length > 1 ? "s" : ""} used`}
                                </p>
                            </div>
                        </div>

                        {/* Messages */}
                        {conversation.messages.map((msg) => (
                            <div key={msg.id} className={`flex gap-3 ${msg.role === "user" ? "justify-end" : ""}`}>
                                {msg.role === "assistant" && (
                                    <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 mt-1">
                                        <Bot className="h-4 w-4 text-primary" />
                                    </div>
                                )}
                                <div
                                    className={`max-w-[80%] ${msg.role === "user"
                                        ? "bg-primary text-primary-foreground rounded-2xl rounded-br-md px-4 py-3"
                                        : `bg-card border rounded-2xl rounded-bl-md px-5 py-4 shadow-sm cursor-pointer transition-colors ${selectedMsgId === msg.id ? "border-primary ring-1 ring-primary/20" : "border-border hover:border-primary/30"
                                        }`
                                        }`}
                                    onClick={() => {
                                        if (msg.role === "assistant") {
                                            setSelectedMsgId(selectedMsgId === msg.id ? null : msg.id);
                                        }
                                    }}
                                >
                                    {msg.role === "user" ? (
                                        <>
                                            <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                                            {msg.file_ids && msg.file_ids.length > 0 && (
                                                <div className="flex items-center gap-1.5 mt-2 text-primary-foreground/70">
                                                    <ExternalLink className="h-3 w-3" />
                                                    <span className="text-[10px] font-medium">{msg.file_ids.length} file{msg.file_ids.length > 1 ? "s" : ""}</span>
                                                </div>
                                            )}
                                        </>
                                    ) : (
                                        <>
                                            <div className="prose-sm">{renderMarkdown(msg.content)}</div>
                                            {/* Footer: tokens + citations indicator */}
                                            <div className="flex items-center gap-3 mt-3 pt-2 border-t border-border/50 text-muted-foreground">
                                                {msg.tokens && (
                                                    <span className="inline-flex items-center gap-1 text-[10px] font-medium">
                                                        <Zap className="h-3 w-3" /> {formatTokens(msg.tokens.total)} tokens
                                                    </span>
                                                )}
                                                {msg.citations && msg.citations.length > 0 && (
                                                    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-primary">
                                                        <BookOpen className="h-3 w-3" /> {msg.citations.length} citation{msg.citations.length > 1 ? "s" : ""}
                                                    </span>
                                                )}
                                                <span className="text-[10px]">{formatDate(msg.created_at)}</span>
                                            </div>
                                        </>
                                    )}
                                </div>
                                {msg.role === "user" && (
                                    <div className="w-8 h-8 rounded-lg bg-foreground/10 flex items-center justify-center shrink-0 mt-1">
                                        <User className="h-4 w-4 text-foreground" />
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </main>

                {/* ─── RIGHT: Citation + Usage Panel ─── */}
                <aside className="w-80 shrink-0 bg-card border-l border-border flex flex-col overflow-y-auto">
                    <div className="p-4 space-y-5">

                        {/* Token Usage Summary */}
                        <div>
                            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                                Token Usage Summary
                            </p>
                            <div className="bg-muted/30 rounded-xl border border-border/50 overflow-hidden">
                                {/* Totals */}
                                <div className="p-3 space-y-2">
                                    <div className="flex items-center justify-between">
                                        <span className="text-xs text-muted-foreground">Prompt</span>
                                        <span className="text-xs font-bold text-foreground">{formatTokens(totalTokens.prompt)}</span>
                                    </div>
                                    <div className="flex items-center justify-between">
                                        <span className="text-xs text-muted-foreground">Completion</span>
                                        <span className="text-xs font-bold text-foreground">{formatTokens(totalTokens.completion)}</span>
                                    </div>
                                    <div className="flex items-center justify-between pt-1.5 border-t border-border/50">
                                        <span className="text-xs font-semibold text-foreground">Total</span>
                                        <span className="text-xs font-bold text-primary">{formatTokens(totalTokens.total)}</span>
                                    </div>
                                </div>
                                {/* Per-message table */}
                                {assistantMessages.length > 0 && (
                                    <div className="border-t border-border/50">
                                        <div className="px-3 py-2 bg-muted/50">
                                            <p className="text-[10px] font-semibold text-muted-foreground uppercase">Per Message</p>
                                        </div>
                                        <div className="divide-y divide-border/50">
                                            {assistantMessages.map((msg, idx) => (
                                                <button
                                                    key={msg.id}
                                                    onClick={() => setSelectedMsgId(selectedMsgId === msg.id ? null : msg.id)}
                                                    className={`w-full px-3 py-2 flex items-center justify-between text-left transition-colors ${selectedMsgId === msg.id ? "bg-primary/5" : "hover:bg-muted/20"
                                                        }`}
                                                >
                                                    <span className="text-[11px] text-muted-foreground font-medium">
                                                        Msg #{idx + 1}
                                                    </span>
                                                    <div className="flex items-center gap-2">
                                                        {msg.citations && msg.citations.length > 0 && (
                                                            <span className="text-[10px] text-primary font-bold">
                                                                {msg.citations.length}📎
                                                            </span>
                                                        )}
                                                        <span className="text-[11px] font-bold text-foreground">
                                                            {msg.tokens ? formatTokens(msg.tokens.total) : "—"}
                                                        </span>
                                                    </div>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Selected Message Citations */}
                        <div>
                            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                                Citations
                            </p>
                            {!selectedMsg || !selectedMsg.citations || selectedMsg.citations.length === 0 ? (
                                <div className="bg-muted/30 rounded-lg border border-border/50 p-4 text-center">
                                    <BookOpen className="h-5 w-5 text-muted-foreground/40 mx-auto mb-1.5" />
                                    <p className="text-[10px] text-muted-foreground">
                                        {selectedMsg ? "No citations for this message" : "Click an assistant message to view its citations"}
                                    </p>
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    {selectedMsg.citations.map((c: Citation, idx: number) => (
                                        <div key={idx} className="bg-muted/30 rounded-lg border border-border/50 p-3">
                                            <div className="flex items-center gap-2 mb-1">
                                                <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-primary/10 text-primary text-[10px] font-bold">
                                                    {idx + 1}
                                                </span>
                                                <span className="text-xs font-semibold text-foreground truncate">
                                                    {c.filename || `File ${c.file_id?.slice(0, 8)}…`}
                                                </span>
                                                {c.page && <span className="text-[10px] text-muted-foreground">p.{c.page}</span>}
                                            </div>
                                            {c.text && (
                                                <p className="text-[11px] text-muted-foreground leading-relaxed line-clamp-4 mt-1">
                                                    {c.text}
                                                </p>
                                            )}
                                            {c.score !== undefined && (
                                                <div className="flex items-center gap-1 mt-1.5">
                                                    <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
                                                        <div className="h-full bg-primary/60 rounded-full" style={{ width: `${Math.round(c.score * 100)}%` }} />
                                                    </div>
                                                    <span className="text-[9px] text-muted-foreground">{(c.score * 100).toFixed(0)}%</span>
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Actions */}
                        <div className="pt-3 border-t border-border/50 space-y-2">
                            <Button
                                onClick={() => router.push(`/chat?conversation_id=${convId}`)}
                                className="w-full text-xs font-bold shadow-sm"
                            >
                                <Play className="h-3.5 w-3.5 mr-1.5" /> Continue This Chat
                            </Button>
                            {allFileIds.length > 0 && (
                                <Button
                                    variant="outline"
                                    onClick={() => router.push(`/chat?file_ids=${allFileIds.join(",")}`)}
                                    className="w-full text-xs font-semibold"
                                >
                                    <MessageSquare className="h-3.5 w-3.5 mr-1.5" /> New Chat with Same Files
                                </Button>
                            )}
                        </div>
                    </div>
                </aside>
            </div>
        </div>
    );
}
