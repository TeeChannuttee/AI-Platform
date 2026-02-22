"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useRouter, useParams } from "next/navigation";
import {
    FileText,
    Image as ImageIcon,
    Download,
    RefreshCw,
    AlertTriangle,
    ChevronRight,
    LayoutGrid,
    LogOut,
    ArrowLeft,
    ShieldAlert,
    Clock,
    FileCheck,
    Bug,
    Search,
    Upload,
    XCircle,
    ExternalLink,
    Lock,
    MessageSquare,
    HardDrive,
    Eye,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { fileApi, ApiRequestError } from "@/lib/api";
import type { FileInfo } from "@/lib/api";
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

function formatSize(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function mimeLabel(mime: string | null): string {
    if (!mime) return "File";
    const map: Record<string, string> = {
        "application/pdf": "PDF Document",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word Document",
        "text/plain": "Text File",
        "text/csv": "CSV Spreadsheet",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel Spreadsheet",
        "image/png": "PNG Image",
        "image/jpeg": "JPEG Image",
        "image/jpg": "JPEG Image",
        "image/gif": "GIF Image",
    };
    return map[mime] || mime;
}

const STATUS_CONFIG: Record<string, { bg: string; text: string; icon: React.ElementType; label: string }> = {
    uploading: { bg: "bg-blue-50", text: "text-blue-700", icon: Upload, label: "Uploading" },
    scanning: { bg: "bg-amber-50", text: "text-amber-700", icon: ShieldAlert, label: "Scanning" },
    quarantined: { bg: "bg-red-50", text: "text-red-700", icon: Bug, label: "Quarantined" },
    processing: { bg: "bg-violet-50", text: "text-violet-700", icon: Search, label: "Processing" },
    ready: { bg: "bg-emerald-50", text: "text-emerald-700", icon: FileCheck, label: "Ready" },
    error: { bg: "bg-red-50", text: "text-red-700", icon: XCircle, label: "Error" },
};

// ═══════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════

export default function FileViewerPage() {
    const router = useRouter();
    const params = useParams();
    const fileId = params.id as string;
    const { token, logout, isLoading: authLoading } = useAuth();

    const [file, setFile] = useState<FileInfo | null>(null);
    const [viewUrl, setViewUrl] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<{ status: number; message: string } | null>(null);
    const [polling, setPolling] = useState(false);

    // ─── Load ───

    const loadFile = useCallback(async () => {
        if (!token || !fileId) return;
        setLoading(true);
        setError(null);
        try {
            const data = await fileApi.get(token, fileId);
            setFile(data);

            // If ready, get view URL
            if (data.status === "ready") {
                try {
                    const view = await fileApi.getViewUrl(token, fileId);
                    setViewUrl(view.url);
                } catch {
                    // View URL might fail for non-viewable files
                }
            }

            // Start polling for in-progress files
            if (["uploading", "scanning", "processing"].includes(data.status)) {
                setPolling(true);
            } else {
                setPolling(false);
            }
        } catch (err) {
            if (err instanceof ApiRequestError) {
                if (err.status === 401) { await logout(); router.push("/login"); return; }
                setError({ status: err.status, message: err.data.detail });
            } else {
                setError({ status: 0, message: "Cannot connect to server" });
            }
        } finally {
            setLoading(false);
        }
    }, [token, fileId, logout, router]);

    useEffect(() => {
        if (!authLoading && !token) { router.push("/login"); return; }
        if (token) loadFile();
    }, [token, authLoading, router, loadFile]);

    // Polling for in-progress files
    useEffect(() => {
        if (!polling || !token || !fileId) return;
        const interval = setInterval(async () => {
            try {
                const updated = await fileApi.get(token, fileId);
                setFile(updated);
                if (!["uploading", "scanning", "processing"].includes(updated.status)) {
                    setPolling(false);
                    // Fetch view URL if now ready
                    if (updated.status === "ready") {
                        try {
                            const view = await fileApi.getViewUrl(token, fileId);
                            setViewUrl(view.url);
                        } catch { /* ignore */ }
                    }
                }
            } catch { /* ignore polling errors */ }
        }, 2500);
        return () => clearInterval(interval);
    }, [polling, token, fileId]);

    // ─── Derived ───

    const isImage = file?.mime_type?.startsWith("image/");
    const isPdf = file?.mime_type === "application/pdf";
    const isReady = file?.status === "ready";
    const isQuarantined = file?.status === "quarantined";
    const isPending = file ? ["uploading", "scanning", "processing"].includes(file.status) : false;
    const progress = file && file.chunks_total > 0
        ? Math.round((file.chunks_processed / file.chunks_total) * 100)
        : null;

    // ─── Render: Loading ───

    if (authLoading || loading) {
        return (
            <div className="min-h-screen bg-background flex items-center justify-center">
                <div className="flex flex-col items-center gap-3">
                    <RefreshCw className="h-6 w-6 text-primary animate-spin" />
                    <p className="text-sm text-muted-foreground font-medium">Loading file…</p>
                </div>
            </div>
        );
    }

    // ─── Render: Error ───

    if (error) {
        const is403 = error.status === 403;
        const is404 = error.status === 404;

        return (
            <div className="min-h-screen bg-background flex items-center justify-center p-4">
                <div className="bg-card rounded-2xl border border-border shadow-sm p-8 max-w-md w-full text-center">
                    <div className={`w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-5 ${is403 ? "bg-amber-50" : "bg-destructive/10"
                        }`}>
                        {is403 ? (
                            <Lock className="h-7 w-7 text-amber-600" />
                        ) : is404 ? (
                            <HardDrive className="h-7 w-7 text-muted-foreground" />
                        ) : (
                            <AlertTriangle className="h-7 w-7 text-destructive" />
                        )}
                    </div>
                    <h2 className="text-xl font-bold text-foreground mb-2">
                        {is403 ? "Access Denied" : is404 ? "File Not Found" : "Something went wrong"}
                    </h2>
                    <p className="text-muted-foreground text-sm mb-6">
                        {is403
                            ? "You don't have permission to view this file. Contact your administrator."
                            : error.message}
                    </p>
                    <div className="flex items-center gap-3 justify-center">
                        <Button variant="outline" onClick={() => router.push("/files")}>
                            <ArrowLeft className="h-4 w-4 mr-2" /> Back to Files
                        </Button>
                        {!is403 && (
                            <Button onClick={loadFile} variant="outline">
                                <RefreshCw className="h-4 w-4 mr-2" /> Retry
                            </Button>
                        )}
                    </div>
                </div>
            </div>
        );
    }

    if (!file) return null;

    const statusCfg = STATUS_CONFIG[file.status] || STATUS_CONFIG.error;
    const StatusIcon = statusCfg.icon;

    return (
        <div className="min-h-screen bg-background flex flex-col">
            {/* Header */}
            <header className="sticky top-0 z-30 bg-card/80 backdrop-blur-md border-b border-border">
                <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
                    <div className="flex items-center gap-3 min-w-0">
                        <Button variant="outline" size="sm" onClick={() => router.push("/files")} className="shrink-0">
                            <ArrowLeft className="h-3.5 w-3.5" />
                        </Button>
                        <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center text-primary-foreground shrink-0">
                            <LayoutGrid className="h-4 w-4" />
                        </div>
                        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span className="text-sm text-muted-foreground shrink-0">Files</span>
                        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span className="text-sm font-bold text-foreground truncate">{file.filename}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        {isReady && viewUrl && (
                            <Button
                                variant="outline" size="sm"
                                onClick={() => window.open(viewUrl, "_blank")}
                                className="text-xs font-semibold"
                            >
                                <Download className="h-3.5 w-3.5 mr-1.5" /> Download
                            </Button>
                        )}
                        {isReady && (
                            <Button
                                variant="outline" size="sm"
                                onClick={() => router.push(`/chat?file_ids=${file.id}`)}
                                className="text-xs font-semibold border-primary/20 text-primary hover:bg-primary/5"
                            >
                                <MessageSquare className="h-3.5 w-3.5 mr-1.5" /> Use in Chat
                            </Button>
                        )}
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

            {/* File info bar */}
            <div className="bg-card border-b border-border">
                <div className="max-w-7xl mx-auto px-6 py-4">
                    <div className="flex flex-wrap items-center gap-4">
                        {/* Status */}
                        <span className={`inline-flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-full ${statusCfg.bg} ${statusCfg.text}`}>
                            <StatusIcon className="h-3.5 w-3.5" />
                            {statusCfg.label}
                            {polling && <RefreshCw className="h-3 w-3 animate-spin ml-0.5" />}
                        </span>

                        <span className="text-xs text-muted-foreground">·</span>
                        <span className="text-xs text-muted-foreground font-medium">{mimeLabel(file.mime_type)}</span>

                        <span className="text-xs text-muted-foreground">·</span>
                        <span className="text-xs text-muted-foreground font-medium">{formatSize(file.size)}</span>

                        <span className="text-xs text-muted-foreground">·</span>
                        <span className="text-xs text-muted-foreground font-medium flex items-center gap-1">
                            <Clock className="h-3 w-3" /> {formatDate(file.created_at)}
                        </span>

                        {progress !== null && isPending && (
                            <>
                                <span className="text-xs text-muted-foreground">·</span>
                                <span className="text-xs font-bold text-primary">
                                    {file.chunks_processed}/{file.chunks_total} chunks ({progress}%)
                                </span>
                            </>
                        )}
                    </div>

                    {/* Progress bar for pending files */}
                    {isPending && progress !== null && (
                        <div className="mt-3 w-full max-w-xl">
                            <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
                                <div
                                    className="h-full bg-primary rounded-full transition-all duration-500"
                                    style={{ width: `${progress}%` }}
                                />
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* ═══ VIEWER AREA ═══ */}
            <main className="flex-1 flex items-center justify-center p-6">
                {/* Quarantined */}
                {isQuarantined && (
                    <div className="bg-card rounded-2xl border border-red-200 shadow-sm p-10 max-w-lg w-full text-center">
                        <div className="w-16 h-16 rounded-2xl bg-red-50 flex items-center justify-center mx-auto mb-5">
                            <ShieldAlert className="h-8 w-8 text-red-600" />
                        </div>
                        <h2 className="text-xl font-bold text-foreground mb-2">File Quarantined</h2>
                        <p className="text-sm text-muted-foreground mb-2">
                            A virus or malware was detected by <span className="font-bold">ClamAV</span>. This file cannot be viewed or downloaded.
                        </p>
                        <p className="text-xs text-red-600 font-medium">
                            Contact your administrator to review this file.
                        </p>
                        <Button variant="outline" onClick={() => router.push("/files")} className="mt-6 font-semibold">
                            <ArrowLeft className="h-4 w-4 mr-2" /> Back to Files
                        </Button>
                    </div>
                )}

                {/* Pending (uploading / scanning / indexing) */}
                {isPending && (
                    <div className="bg-card rounded-2xl border border-border shadow-sm p-10 max-w-lg w-full text-center">
                        <div className={`w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-5 ${statusCfg.bg}`}>
                            <StatusIcon className={`h-8 w-8 ${statusCfg.text}`} />
                        </div>
                        <h2 className="text-xl font-bold text-foreground mb-2">File is being processed</h2>
                        <p className="text-sm text-muted-foreground mb-4">
                            {file.status === "uploading" && "Your file is still uploading. Please wait…"}
                            {file.status === "scanning" && "ClamAV is scanning this file for viruses. This usually takes a few seconds."}
                            {file.status === "processing" && "Your file is being parsed, chunked, and embedded for AI search."}
                        </p>
                        {progress !== null && (
                            <div className="max-w-xs mx-auto mb-4">
                                <div className="flex items-center justify-between mb-1">
                                    <span className="text-xs text-muted-foreground">Progress</span>
                                    <span className="text-xs font-bold text-primary">{progress}%</span>
                                </div>
                                <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                                    <div
                                        className="h-full bg-primary rounded-full transition-all duration-500"
                                        style={{ width: `${progress}%` }}
                                    />
                                </div>
                                <p className="text-xs text-muted-foreground mt-1">
                                    {file.chunks_processed} / {file.chunks_total} chunks
                                </p>
                            </div>
                        )}
                        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                            <RefreshCw className="h-3 w-3 animate-spin" />
                            <span>Auto-refreshing every 2.5 seconds</span>
                        </div>
                    </div>
                )}

                {/* Error state */}
                {file.status === "error" && (
                    <div className="bg-card rounded-2xl border border-border shadow-sm p-10 max-w-lg w-full text-center">
                        <div className="w-16 h-16 rounded-2xl bg-red-50 flex items-center justify-center mx-auto mb-5">
                            <XCircle className="h-8 w-8 text-red-600" />
                        </div>
                        <h2 className="text-xl font-bold text-foreground mb-2">Processing Failed</h2>
                        <p className="text-sm text-muted-foreground mb-4">
                            An error occurred while processing this file. You can try re-uploading it.
                        </p>
                        <Button variant="outline" onClick={() => router.push("/files")} className="font-semibold">
                            <ArrowLeft className="h-4 w-4 mr-2" /> Back to Files
                        </Button>
                    </div>
                )}

                {/* Ready — Image preview */}
                {isReady && isImage && viewUrl && (
                    <div className="max-w-4xl w-full">
                        <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
                            <div className="bg-muted/30 p-1">
                                <img
                                    src={viewUrl}
                                    alt={file.filename}
                                    className="w-full h-auto max-h-[70vh] object-contain rounded-xl"
                                    onError={(e) => {
                                        (e.target as HTMLImageElement).style.display = "none";
                                        setViewUrl(null);
                                    }}
                                />
                            </div>
                        </div>
                    </div>
                )}

                {/* Ready — PDF embed */}
                {isReady && isPdf && viewUrl && (
                    <div className="max-w-5xl w-full h-[calc(100vh-180px)]">
                        <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden h-full flex flex-col">
                            <div className="flex items-center justify-between px-4 py-2 bg-muted/50 border-b border-border">
                                <span className="text-xs font-semibold text-muted-foreground">PDF Preview</span>
                                <Button
                                    variant="outline" size="sm"
                                    onClick={() => window.open(viewUrl, "_blank")}
                                    className="text-xs font-semibold"
                                >
                                    <ExternalLink className="h-3 w-3 mr-1" /> Open in New Tab
                                </Button>
                            </div>
                            <iframe
                                src={viewUrl}
                                className="flex-1 w-full"
                                title={file.filename}
                            />
                        </div>
                    </div>
                )}

                {/* Ready — Other file types (download only) */}
                {isReady && !isImage && !isPdf && (
                    <div className="bg-card rounded-2xl border border-border shadow-sm p-10 max-w-lg w-full text-center">
                        <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mx-auto mb-5">
                            <FileText className="h-8 w-8 text-muted-foreground" />
                        </div>
                        <h2 className="text-xl font-bold text-foreground mb-2">{file.filename}</h2>
                        <p className="text-sm text-muted-foreground mb-1">{mimeLabel(file.mime_type)}</p>
                        <p className="text-sm text-muted-foreground mb-6">{formatSize(file.size)}</p>
                        <p className="text-xs text-muted-foreground mb-5">
                            Preview is not available for this file type. You can download it or use it with the AI assistant.
                        </p>
                        <div className="flex items-center gap-3 justify-center">
                            {viewUrl && (
                                <Button onClick={() => window.open(viewUrl, "_blank")} className="font-bold text-sm shadow-sm">
                                    <Download className="h-4 w-4 mr-2" /> Download
                                </Button>
                            )}
                            <Button
                                variant="outline"
                                onClick={() => router.push(`/chat?file_ids=${file.id}`)}
                                className="font-bold text-sm border-primary/20 text-primary hover:bg-primary/5"
                            >
                                <MessageSquare className="h-4 w-4 mr-2" /> Use in Chat
                            </Button>
                        </div>
                    </div>
                )}

                {/* Ready but no URL */}
                {isReady && !viewUrl && !isImage && !isPdf && (
                    <></>
                )}
            </main>
        </div>
    );
}
