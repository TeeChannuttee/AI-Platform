"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
    Send,
    Plus,
    Upload,
    Paperclip,
    MessageSquare,
    FileText,
    Trash2,
    RefreshCw,
    AlertTriangle,
    CheckCircle2,
    XCircle,
    ChevronRight,
    LayoutGrid,
    LogOut,
    X,
    Clock,
    Zap,
    BookOpen,
    Hash,
    Info,
    Code,
    List,
    Table,
    ExternalLink,
    Bot,
    User,
    Sparkles,
    PanelRightOpen,
    PanelRightClose,
    FolderOpen,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { llmApi, fileApi, ApiRequestError } from "@/lib/api";
import type {
    ChatMessage,
    Citation,
    ChatResponseData,
    ConversationItem,
    FileInfo,
} from "@/lib/api";
import { Button } from "@/components/ui/button";

// ─── Helpers ───

function formatDate(iso: string | null): string {
    if (!iso) return "";
    const d = new Date(iso);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 60000) return "Just now";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatTokens(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return n.toString();
}

// ─── Simple Markdown Renderer ───

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
                <div key={`table-${elements.length}`} className="my-3 overflow-x-auto rounded-lg border border-border">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="bg-muted/50">
                                {tableRows[0].map((cell, ci) => (
                                    <th key={ci} className="px-3 py-2 text-left font-semibold text-foreground border-b border-border">
                                        {cell.trim()}
                                    </th>
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

        // Code block
        if (line.startsWith("```")) {
            if (inCodeBlock) {
                elements.push(
                    <div key={`code-${i}`} className="my-3 rounded-lg bg-[#1e1e2e] overflow-hidden">
                        <div className="flex items-center justify-between px-4 py-2 bg-[#181825] border-b border-[#313244]">
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

        // Table
        if (line.includes("|") && line.trim().startsWith("|")) {
            const cells = line.split("|").filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
            if (!inTable) inTable = true;
            tableRows.push(cells);
            continue;
        } else {
            flushTable();
        }

        // Headers
        if (line.startsWith("### ")) {
            elements.push(<h3 key={i} className="text-base font-bold text-foreground mt-4 mb-2">{line.slice(4)}</h3>);
            continue;
        }
        if (line.startsWith("## ")) {
            elements.push(<h2 key={i} className="text-lg font-bold text-foreground mt-4 mb-2">{line.slice(3)}</h2>);
            continue;
        }
        if (line.startsWith("# ")) {
            elements.push(<h1 key={i} className="text-xl font-bold text-foreground mt-4 mb-2">{line.slice(2)}</h1>);
            continue;
        }

        // List items
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

        // Empty line
        if (line.trim() === "") {
            elements.push(<div key={i} className="h-2" />);
            continue;
        }

        // Normal paragraph
        elements.push(
            <p key={i} className="text-sm text-foreground leading-relaxed my-1">{renderInline(line)}</p>
        );
    }

    flushTable();
    return <>{elements}</>;
}

function renderInline(text: string): React.ReactNode {
    // Handle inline code, bold, italic, citations
    const parts: React.ReactNode[] = [];
    // Simple regex-based inline parsing
    const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[citation:(\d+)\])/g;
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIndex) {
            parts.push(text.slice(lastIndex, match.index));
        }
        const m = match[0];
        if (m.startsWith("`") && m.endsWith("`")) {
            parts.push(
                <code key={match.index} className="px-1.5 py-0.5 bg-muted rounded text-xs font-mono text-foreground">
                    {m.slice(1, -1)}
                </code>
            );
        } else if (m.startsWith("**") && m.endsWith("**")) {
            parts.push(<strong key={match.index} className="font-bold">{m.slice(2, -2)}</strong>);
        } else if (m.startsWith("*") && m.endsWith("*")) {
            parts.push(<em key={match.index}>{m.slice(1, -1)}</em>);
        } else if (m.startsWith("[citation:")) {
            const num = match[2];
            parts.push(
                <span
                    key={match.index}
                    className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-primary/10 text-primary text-[10px] font-bold rounded-md cursor-pointer hover:bg-primary/20 transition-colors mx-0.5"
                    title={`Citation ${num}`}
                >
                    <BookOpen className="h-2.5 w-2.5" />{num}
                </span>
            );
        }
        lastIndex = match.index + m.length;
    }

    if (lastIndex < text.length) {
        parts.push(text.slice(lastIndex));
    }

    return parts.length > 0 ? <>{parts}</> : text;
}

// ═══════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════

export default function ChatPage() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { token, logout, isLoading: authLoading } = useAuth();
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Conversations
    const [conversations, setConversations] = useState<ConversationItem[]>([]);
    const [activeConvId, setActiveConvId] = useState<string | null>(null);

    // Messages
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState("");
    const [sending, setSending] = useState(false);
    const [lastResponse, setLastResponse] = useState<ChatResponseData | null>(null);

    // Files
    const [attachedFiles, setAttachedFiles] = useState<{ id: string; name: string }[]>([]);
    const [uploadingFile, setUploadingFile] = useState(false);

    // Existing files picker
    const [showFilePicker, setShowFilePicker] = useState(false);
    const [availableFiles, setAvailableFiles] = useState<FileInfo[]>([]);

    // Panel
    const [showPanel, setShowPanel] = useState(true);

    // Loading / error
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Toast
    const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
    const showToast = useCallback((m: string, t: "success" | "error") => {
        setToast({ message: m, type: t });
        setTimeout(() => setToast(null), 4000);
    }, []);

    // ─── Load conversations ───

    const loadConversations = useCallback(async () => {
        if (!token) return;
        try {
            const data = await llmApi.listConversations(token);
            setConversations(data);
        } catch { /* ignore */ }
    }, [token]);

    // ─── Load conversation messages ───

    const loadConversation = useCallback(async (convId: string) => {
        if (!token) return;
        try {
            const data = await llmApi.getConversation(token, convId);
            setMessages(data.messages);
            setActiveConvId(convId);
        } catch (err) {
            if (err instanceof ApiRequestError && err.status === 404) {
                showToast("Conversation not found", "error");
            }
        }
    }, [token, showToast]);

    // ─── Init ───

    useEffect(() => {
        if (!authLoading && !token) { router.push("/login"); return; }
        if (!token) return;

        const init = async () => {
            setLoading(true);
            await loadConversations();

            // Check for file_ids from query params
            const fileIds = searchParams.get("file_ids");
            if (fileIds) {
                const ids = fileIds.split(",");
                setAttachedFiles(ids.map((id) => ({ id, name: `File ${id.slice(0, 8)}…` })));
            }
            setLoading(false);
        };
        init();
    }, [token, authLoading, router, loadConversations, searchParams]);

    // Auto-scroll
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    // ─── Send message ───

    const handleSend = async () => {
        if (!input.trim() || !token || sending) return;

        const userMsg: ChatMessage = {
            id: `temp-${Date.now()}`,
            role: "user",
            content: input.trim(),
            citations: null,
            file_ids: attachedFiles.length > 0 ? attachedFiles.map((f) => f.id) : null,
            tokens: null,
            model: null,
            created_at: new Date().toISOString(),
        };

        setMessages((prev) => [...prev, userMsg]);
        setInput("");
        setSending(true);
        setLastResponse(null);

        try {
            const res = await llmApi.chat(token, {
                message: userMsg.content,
                conversation_id: activeConvId || undefined,
                file_ids: attachedFiles.length > 0 ? attachedFiles.map((f) => f.id) : undefined,
            });

            if (!activeConvId) {
                setActiveConvId(res.conversation_id);
                await loadConversations();
            }

            const assistantMsg: ChatMessage = {
                id: res.message_id,
                role: "assistant",
                content: res.answer,
                citations: res.citations,
                file_ids: null,
                tokens: {
                    prompt: res.usage_tokens.prompt_tokens,
                    completion: res.usage_tokens.completion_tokens,
                    total: res.usage_tokens.total_tokens,
                },
                model: null,
                created_at: new Date().toISOString(),
            };

            setMessages((prev) => [...prev, assistantMsg]);
            setLastResponse(res);
        } catch (err) {
            if (err instanceof ApiRequestError) {
                if (err.status === 503) {
                    setMessages((prev) => [
                        ...prev,
                        {
                            id: `err-${Date.now()}`,
                            role: "assistant",
                            content: "⚠️ **LLM temporarily unavailable.** The service circuit breaker is open. Please retry in a minute.",
                            citations: null, file_ids: null, tokens: null, model: null,
                            created_at: new Date().toISOString(),
                        },
                    ]);
                } else {
                    showToast(err.data.detail, "error");
                }
            } else {
                showToast("Network error", "error");
            }
        } finally {
            setSending(false);
        }
    };

    // ─── Upload file to chat ───

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file || !token) return;
        e.target.value = "";

        setUploadingFile(true);
        try {
            const res = await llmApi.chatUpload(token, file);
            setAttachedFiles((prev) => [...prev, { id: res.file_id, name: res.filename || file.name }]);
            showToast(`"${file.name}" attached`, "success");
        } catch (err) {
            if (err instanceof ApiRequestError) showToast(err.data.detail, "error");
            else showToast("Upload failed", "error");
        } finally {
            setUploadingFile(false);
        }
    };

    // ─── Pick existing file ───

    const openFilePicker = async () => {
        if (!token) return;
        setShowFilePicker(true);
        try {
            const data = await fileApi.list(token, "ready");
            setAvailableFiles(data);
        } catch { /* ignore */ }
    };

    const attachExistingFile = (f: FileInfo) => {
        if (attachedFiles.find((a) => a.id === f.id)) return;
        setAttachedFiles((prev) => [...prev, { id: f.id, name: f.filename }]);
        setShowFilePicker(false);
    };

    // ─── New chat ───

    const startNewChat = () => {
        setActiveConvId(null);
        setMessages([]);
        setLastResponse(null);
        setAttachedFiles([]);
        textareaRef.current?.focus();
    };

    // ─── Delete conversation ───

    const handleDeleteConv = async (convId: string) => {
        if (!token) return;
        try {
            await llmApi.deleteConversation(token, convId);
            setConversations((prev) => prev.filter((c) => c.id !== convId));
            if (activeConvId === convId) startNewChat();
            showToast("Conversation deleted", "success");
        } catch { /* ignore */ }
    };

    // ─── Keyboard ───

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    // ─── Loading ───

    if (authLoading || loading) {
        return (
            <div className="min-h-screen bg-background flex items-center justify-center">
                <div className="flex flex-col items-center gap-3">
                    <RefreshCw className="h-6 w-6 text-primary animate-spin" />
                    <p className="text-sm text-muted-foreground font-medium">Loading…</p>
                </div>
            </div>
        );
    }

    // ─── Derived ───

    const latestCitations = lastResponse?.citations ?? messages.findLast((m) => m.role === "assistant")?.citations;
    const latestTokens = lastResponse?.usage_tokens ?? (() => {
        const lastAssistant = messages.findLast((m) => m.role === "assistant" && m.tokens);
        return lastAssistant?.tokens
            ? { prompt_tokens: lastAssistant.tokens.prompt, completion_tokens: lastAssistant.tokens.completion, total_tokens: lastAssistant.tokens.total }
            : null;
    })();
    const invalidCount = lastResponse?.invalid_citation_count ?? 0;

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

            {/* File Picker Modal */}
            {showFilePicker && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setShowFilePicker(false)} />
                    <div className="relative bg-card rounded-2xl border border-border shadow-2xl max-w-md w-full max-h-[70vh] overflow-auto">
                        <div className="sticky top-0 bg-card border-b border-border px-5 py-4 flex items-center justify-between z-10">
                            <h3 className="text-base font-bold text-foreground">Select a File</h3>
                            <button onClick={() => setShowFilePicker(false)} className="p-1.5 rounded-lg hover:bg-muted">
                                <X className="h-4 w-4 text-muted-foreground" />
                            </button>
                        </div>
                        {availableFiles.length === 0 ? (
                            <div className="px-5 py-10 text-center">
                                <FolderOpen className="h-8 w-8 text-muted-foreground/40 mx-auto mb-3" />
                                <p className="text-sm text-muted-foreground">No ready files available</p>
                            </div>
                        ) : (
                            <div className="divide-y divide-border">
                                {availableFiles.map((f) => (
                                    <button
                                        key={f.id}
                                        onClick={() => attachExistingFile(f)}
                                        disabled={!!attachedFiles.find((a) => a.id === f.id)}
                                        className="w-full px-5 py-3 flex items-center gap-3 hover:bg-muted/30 transition-colors text-left disabled:opacity-40"
                                    >
                                        <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                                        <div className="min-w-0 flex-1">
                                            <p className="text-sm font-semibold text-foreground truncate">{f.filename}</p>
                                            <p className="text-xs text-muted-foreground">{(f.size / 1024).toFixed(0)} KB</p>
                                        </div>
                                        {attachedFiles.find((a) => a.id === f.id) && (
                                            <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
                                        )}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Header */}
            <header className="shrink-0 bg-card/80 backdrop-blur-md border-b border-border z-20">
                <div className="px-6 h-14 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center text-primary-foreground">
                            <LayoutGrid className="h-3.5 w-3.5" />
                        </div>
                        <span className="font-bold text-foreground text-sm tracking-tight">Enterprise AI Platform</span>
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        <span className="font-semibold text-foreground text-sm">AI Assistant</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button
                            variant="outline" size="sm"
                            onClick={() => setShowPanel(!showPanel)}
                            className="text-xs font-semibold"
                        >
                            {showPanel ? <PanelRightClose className="h-3.5 w-3.5" /> : <PanelRightOpen className="h-3.5 w-3.5" />}
                        </Button>
                        <Button
                            variant="outline" size="sm"
                            onClick={async () => { await logout(); router.push("/login"); }}
                            className="text-xs font-semibold"
                        >
                            <LogOut className="h-3.5 w-3.5 mr-1" /> Sign Out
                        </Button>
                    </div>
                </div>
            </header>

            {/* ═══ 3-PANE LAYOUT ═══ */}
            <div className="flex-1 flex overflow-hidden">

                {/* ─── LEFT: Conversations ─── */}
                <aside className="w-64 shrink-0 bg-card border-r border-border flex flex-col">
                    <div className="p-3">
                        <Button onClick={startNewChat} className="w-full font-bold text-sm h-9 shadow-sm">
                            <Plus className="h-3.5 w-3.5 mr-1.5" /> New Chat
                        </Button>
                    </div>
                    <div className="flex-1 overflow-y-auto">
                        {conversations.length === 0 ? (
                            <div className="px-4 py-8 text-center">
                                <MessageSquare className="h-6 w-6 text-muted-foreground/30 mx-auto mb-2" />
                                <p className="text-xs text-muted-foreground">No conversations yet</p>
                            </div>
                        ) : (
                            <div className="space-y-0.5 px-2">
                                {conversations.map((c) => (
                                    <div
                                        key={c.id}
                                        className={`group flex items-center gap-2 px-3 py-2.5 rounded-lg cursor-pointer transition-colors ${activeConvId === c.id
                                            ? "bg-primary/10 text-primary"
                                            : "hover:bg-muted text-foreground"
                                            }`}
                                        onClick={() => loadConversation(c.id)}
                                    >
                                        <MessageSquare className="h-3.5 w-3.5 shrink-0 opacity-60" />
                                        <div className="min-w-0 flex-1">
                                            <p className="text-xs font-semibold truncate">{c.title}</p>
                                            <p className="text-[10px] text-muted-foreground mt-0.5">{formatDate(c.updated_at)}</p>
                                        </div>
                                        <button
                                            onClick={(e) => { e.stopPropagation(); handleDeleteConv(c.id); }}
                                            className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-destructive/10 transition-all"
                                        >
                                            <Trash2 className="h-3 w-3 text-destructive" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </aside>

                {/* ─── CENTER: Chat Thread ─── */}
                <main className="flex-1 flex flex-col min-w-0">
                    {/* Messages */}
                    <div className="flex-1 overflow-y-auto">
                        {messages.length === 0 ? (
                            /* Empty state */
                            <div className="h-full flex items-center justify-center p-6">
                                <div className="text-center max-w-md">
                                    <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-5">
                                        <Sparkles className="h-8 w-8 text-primary" />
                                    </div>
                                    <h2 className="text-xl font-bold text-foreground mb-2">Enterprise AI Assistant</h2>
                                    <p className="text-sm text-muted-foreground mb-6">
                                        Ask questions, analyze documents, and get AI-powered insights with citation-backed answers.
                                    </p>
                                    <div className="grid grid-cols-2 gap-3 text-left">
                                        {[
                                            { icon: FileText, label: "Analyze documents", desc: "Upload or attach files" },
                                            { icon: BookOpen, label: "Cited answers", desc: "Evidence-backed responses" },
                                            { icon: Code, label: "Code assistance", desc: "Write and debug code" },
                                            { icon: Table, label: "Data insights", desc: "Summarize and extract" },
                                        ].map(({ icon: IC, label, desc }) => (
                                            <div key={label} className="bg-muted/30 rounded-xl border border-border/50 p-3">
                                                <IC className="h-4 w-4 text-primary mb-1.5" />
                                                <p className="text-xs font-bold text-foreground">{label}</p>
                                                <p className="text-[10px] text-muted-foreground">{desc}</p>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <div className="max-w-3xl mx-auto px-6 py-6 space-y-6">
                                {messages.map((msg) => (
                                    <div key={msg.id} className={`flex gap-3 ${msg.role === "user" ? "justify-end" : ""}`}>
                                        {msg.role === "assistant" && (
                                            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 mt-1">
                                                <Bot className="h-4 w-4 text-primary" />
                                            </div>
                                        )}
                                        <div className={`max-w-[80%] ${msg.role === "user"
                                            ? "bg-primary text-primary-foreground rounded-2xl rounded-br-md px-4 py-3"
                                            : "bg-card border border-border rounded-2xl rounded-bl-md px-5 py-4 shadow-sm"
                                            }`}>
                                            {msg.role === "user" ? (
                                                <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                                            ) : (
                                                <div className="prose-sm">{renderMarkdown(msg.content)}</div>
                                            )}
                                            {/* Token badge for assistant */}
                                            {msg.role === "assistant" && msg.tokens && (
                                                <div className="flex items-center gap-2 mt-3 pt-2 border-t border-border/50">
                                                    <Zap className="h-3 w-3 text-muted-foreground" />
                                                    <span className="text-[10px] text-muted-foreground font-medium">
                                                        {formatTokens(msg.tokens.total)} tokens
                                                    </span>
                                                </div>
                                            )}
                                            {/* Attached files badge */}
                                            {msg.file_ids && msg.file_ids.length > 0 && (
                                                <div className="flex items-center gap-1.5 mt-2">
                                                    <Paperclip className="h-3 w-3 text-primary-foreground/70" />
                                                    <span className="text-[10px] font-medium opacity-80">
                                                        {msg.file_ids.length} file{msg.file_ids.length > 1 ? "s" : ""} attached
                                                    </span>
                                                </div>
                                            )}
                                        </div>
                                        {msg.role === "user" && (
                                            <div className="w-8 h-8 rounded-lg bg-foreground/10 flex items-center justify-center shrink-0 mt-1">
                                                <User className="h-4 w-4 text-foreground" />
                                            </div>
                                        )}
                                    </div>
                                ))}
                                {sending && (
                                    <div className="flex gap-3">
                                        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                                            <Bot className="h-4 w-4 text-primary" />
                                        </div>
                                        <div className="bg-card border border-border rounded-2xl rounded-bl-md px-5 py-4 shadow-sm">
                                            <div className="flex items-center gap-2">
                                                <RefreshCw className="h-4 w-4 text-primary animate-spin" />
                                                <span className="text-sm text-muted-foreground">Thinking…</span>
                                            </div>
                                        </div>
                                    </div>
                                )}
                                <div ref={messagesEndRef} />
                            </div>
                        )}
                    </div>

                    {/* Composer */}
                    <div className="shrink-0 border-t border-border bg-card p-4">
                        {/* Attached files chips */}
                        {attachedFiles.length > 0 && (
                            <div className="flex flex-wrap items-center gap-2 mb-3">
                                {attachedFiles.map((f) => (
                                    <span
                                        key={f.id}
                                        className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-primary/10 text-primary text-xs font-semibold rounded-lg"
                                    >
                                        <FileText className="h-3 w-3" />
                                        <span className="max-w-[120px] truncate">{f.name}</span>
                                        <button
                                            onClick={() => setAttachedFiles((prev) => prev.filter((a) => a.id !== f.id))}
                                            className="hover:text-destructive transition-colors"
                                        >
                                            <X className="h-3 w-3" />
                                        </button>
                                    </span>
                                ))}
                            </div>
                        )}

                        <div className="flex items-center gap-2 max-w-3xl mx-auto">
                            {/* Attach buttons */}
                            <div className="flex items-center gap-1 shrink-0">
                                <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileUpload} />
                                <Button
                                    variant="outline" size="sm"
                                    onClick={openFilePicker}
                                    className="h-[44px] w-[44px] p-0 rounded-xl"
                                    title="Attach existing file"
                                >
                                    <Paperclip className="h-4 w-4" />
                                </Button>
                            </div>

                            {/* Textarea */}
                            <div className="flex-1 relative">
                                <textarea
                                    ref={textareaRef}
                                    value={input}
                                    onChange={(e) => setInput(e.target.value)}
                                    onKeyDown={handleKeyDown}
                                    placeholder="Ask anything… (Enter to send, Shift+Enter for new line)"
                                    rows={1}
                                    className="w-full resize-none rounded-xl border border-border bg-background px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors max-h-32 overflow-y-auto"
                                    style={{ minHeight: "44px" }}
                                    onInput={(e) => {
                                        const el = e.currentTarget;
                                        el.style.height = "44px";
                                        el.style.height = Math.min(el.scrollHeight, 128) + "px";
                                    }}
                                />
                            </div>

                            {/* Send */}
                            <Button
                                onClick={handleSend}
                                disabled={!input.trim() || sending}
                                className="h-[44px] w-[44px] p-0 shrink-0 rounded-xl shadow-sm"
                            >
                                <Send className="h-4 w-4" />
                            </Button>
                        </div>
                    </div>
                </main>

                {/* ─── RIGHT: Context Panel ─── */}
                {showPanel && (
                    <aside className="w-72 shrink-0 bg-card border-l border-border flex flex-col overflow-y-auto">
                        <div className="p-4 space-y-5">
                            {/* Attached Files */}
                            <div>
                                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                                    Attached Files
                                </p>
                                {attachedFiles.length === 0 ? (
                                    <div className="bg-muted/30 rounded-lg border border-border/50 p-3 text-center">
                                        <Paperclip className="h-4 w-4 text-muted-foreground/40 mx-auto mb-1" />
                                        <p className="text-[10px] text-muted-foreground">No files attached</p>
                                    </div>
                                ) : (
                                    <div className="space-y-1.5">
                                        {attachedFiles.map((f) => (
                                            <div key={f.id} className="flex items-center gap-2 px-3 py-2 bg-muted/30 rounded-lg border border-border/50">
                                                <FileText className="h-3.5 w-3.5 text-primary shrink-0" />
                                                <span className="text-xs font-medium text-foreground truncate flex-1">{f.name}</span>
                                                <button
                                                    onClick={() => setAttachedFiles((prev) => prev.filter((a) => a.id !== f.id))}
                                                    className="text-muted-foreground hover:text-destructive"
                                                >
                                                    <X className="h-3 w-3" />
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>

                            {/* Citations / Evidence */}
                            <div>
                                <div className="flex items-center justify-between mb-2">
                                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                                        Evidence
                                    </p>
                                    {invalidCount > 0 && (
                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-50 text-amber-700 text-[10px] font-bold rounded-full">
                                            <AlertTriangle className="h-2.5 w-2.5" />
                                            {invalidCount} invalid
                                        </span>
                                    )}
                                </div>
                                {!latestCitations || latestCitations.length === 0 ? (
                                    <div className="bg-muted/30 rounded-lg border border-border/50 p-3 text-center">
                                        <BookOpen className="h-4 w-4 text-muted-foreground/40 mx-auto mb-1" />
                                        <p className="text-[10px] text-muted-foreground">No citations yet</p>
                                    </div>
                                ) : (
                                    <div className="space-y-2">
                                        {latestCitations.map((c, idx) => (
                                            <div key={idx} className="bg-muted/30 rounded-lg border border-border/50 p-3">
                                                <div className="flex items-center gap-2 mb-1">
                                                    <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-primary/10 text-primary text-[10px] font-bold">
                                                        {idx + 1}
                                                    </span>
                                                    <span className="text-xs font-semibold text-foreground truncate">
                                                        {c.filename || `File ${c.file_id?.slice(0, 8)}…`}
                                                    </span>
                                                    {c.page && (
                                                        <span className="text-[10px] text-muted-foreground">p.{c.page}</span>
                                                    )}
                                                </div>
                                                {c.text && (
                                                    <p className="text-[11px] text-muted-foreground leading-relaxed line-clamp-3">
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

                            {/* Token Usage */}
                            <div>
                                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                                    Token Usage
                                </p>
                                {!latestTokens ? (
                                    <div className="bg-muted/30 rounded-lg border border-border/50 p-3 text-center">
                                        <Zap className="h-4 w-4 text-muted-foreground/40 mx-auto mb-1" />
                                        <p className="text-[10px] text-muted-foreground">Send a message to see usage</p>
                                    </div>
                                ) : (
                                    <div className="bg-muted/30 rounded-lg border border-border/50 p-3 space-y-2">
                                        <div className="flex items-center justify-between">
                                            <span className="text-xs text-muted-foreground">Prompt</span>
                                            <span className="text-xs font-bold text-foreground">{formatTokens(latestTokens.prompt_tokens)}</span>
                                        </div>
                                        <div className="flex items-center justify-between">
                                            <span className="text-xs text-muted-foreground">Completion</span>
                                            <span className="text-xs font-bold text-foreground">{formatTokens(latestTokens.completion_tokens)}</span>
                                        </div>
                                        <div className="flex items-center justify-between pt-1.5 border-t border-border/50">
                                            <span className="text-xs font-semibold text-foreground">Total</span>
                                            <span className="text-xs font-bold text-primary">{formatTokens(latestTokens.total_tokens)}</span>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </aside>
                )}
            </div>
        </div>
    );
}
