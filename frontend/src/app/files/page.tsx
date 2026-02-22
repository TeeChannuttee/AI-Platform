"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import {
    Upload,
    FileText,
    Image,
    Trash2,
    Download,
    MessageSquare,
    RefreshCw,
    AlertTriangle,
    CheckCircle2,
    XCircle,
    ChevronRight,
    LayoutGrid,
    LogOut,
    Search,
    X,
    ShieldAlert,
    Clock,
    FileCheck,
    Bug,
    HardDrive,
    FolderOpen,
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

function mimeIcon(mime: string | null) {
    if (!mime) return FileText;
    if (mime.startsWith("image/")) return Image;
    return FileText;
}

function mimeLabel(mime: string | null): string {
    if (!mime) return "File";
    const map: Record<string, string> = {
        "application/pdf": "PDF",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
        "text/plain": "TXT",
        "text/csv": "CSV",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "XLSX",
        "image/png": "PNG",
        "image/jpeg": "JPEG",
        "image/jpg": "JPG",
        "image/gif": "GIF",
    };
    return map[mime] || mime.split("/")[1]?.toUpperCase() || "File";
}

const STATUS_CONFIG: Record<string, { bg: string; text: string; icon: React.ElementType; label: string }> = {
    uploading: { bg: "bg-blue-50", text: "text-blue-700", icon: Upload, label: "Uploading" },
    scanning: { bg: "bg-amber-50", text: "text-amber-700", icon: ShieldAlert, label: "Scanning" },
    quarantined: { bg: "bg-red-50", text: "text-red-700", icon: Bug, label: "Quarantined" },
    processing: { bg: "bg-violet-50", text: "text-violet-700", icon: Search, label: "Processing" },
    ready: { bg: "bg-emerald-50", text: "text-emerald-700", icon: FileCheck, label: "Ready" },
    error: { bg: "bg-red-50", text: "text-red-700", icon: XCircle, label: "Error" },
    deleted: { bg: "bg-slate-100", text: "text-slate-500", icon: Trash2, label: "Deleted" },
};

const FILTER_OPTIONS = [
    { value: "", label: "All Files" },
    { value: "ready", label: "Ready" },
    { value: "uploading", label: "Uploading" },
    { value: "scanning", label: "Scanning" },
    { value: "processing", label: "Processing" },
    { value: "quarantined", label: "Quarantined" },
    { value: "error", label: "Error" },
];

// ═══════════════════════════════════════════════
// STATUS DRAWER
// ═══════════════════════════════════════════════

function StatusDrawer({
    file, onClose, token,
}: {
    file: FileInfo;
    onClose: () => void;
    token: string;
}) {
    const [liveFile, setLiveFile] = useState(file);
    const [polling, setPolling] = useState(false);

    useEffect(() => {
        setLiveFile(file);
        if (["uploading", "scanning", "processing"].includes(file.status)) {
            setPolling(true);
            const interval = setInterval(async () => {
                try {
                    const updated = await fileApi.get(token, file.id);
                    setLiveFile(updated);
                    if (!["uploading", "scanning", "processing"].includes(updated.status)) {
                        setPolling(false);
                        clearInterval(interval);
                    }
                } catch { /* ignore */ }
            }, 2000);
            return () => clearInterval(interval);
        }
    }, [file, token]);

    const cfg = STATUS_CONFIG[liveFile.status] || STATUS_CONFIG.error;
    const StatusIcon = cfg.icon;
    const progress = liveFile.chunks_total > 0
        ? Math.round((liveFile.chunks_processed / liveFile.chunks_total) * 100)
        : null;
    const Icon = mimeIcon(liveFile.mime_type);

    return (
        <div className="fixed inset-0 z-50 flex justify-end">
            <div className="fixed inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
            <div className="relative w-full max-w-md bg-card border-l border-border shadow-2xl h-full overflow-auto animate-in slide-in-from-right duration-300">
                {/* Header */}
                <div className="sticky top-0 bg-card border-b border-border px-6 py-4 flex items-center justify-between z-10">
                    <h3 className="text-base font-bold text-foreground">File Details</h3>
                    <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-muted transition-colors">
                        <X className="h-4 w-4 text-muted-foreground" />
                    </button>
                </div>

                <div className="p-6 space-y-6">
                    {/* File identity */}
                    <div className="flex items-start gap-4">
                        <div className="w-12 h-12 rounded-xl bg-muted flex items-center justify-center shrink-0">
                            <Icon className="h-6 w-6 text-muted-foreground" />
                        </div>
                        <div className="min-w-0 flex-1">
                            <p className="text-sm font-bold text-foreground break-all">{liveFile.filename}</p>
                            <div className="flex items-center gap-2 mt-1">
                                <span className="text-xs text-muted-foreground">{mimeLabel(liveFile.mime_type)}</span>
                                <span className="text-xs text-muted-foreground">·</span>
                                <span className="text-xs text-muted-foreground">{formatSize(liveFile.size)}</span>
                            </div>
                        </div>
                    </div>

                    {/* Status badge */}
                    <div>
                        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Status</p>
                        <div className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg ${cfg.bg}`}>
                            <StatusIcon className={`h-4 w-4 ${cfg.text}`} />
                            <span className={`text-sm font-bold ${cfg.text}`}>{cfg.label}</span>
                            {polling && <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground ml-1" />}
                        </div>
                    </div>

                    {/* Quarantine warning */}
                    {liveFile.status === "quarantined" && (
                        <div className="flex items-start gap-2.5 px-4 py-3 rounded-lg bg-red-50 border border-red-200">
                            <ShieldAlert className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
                            <div>
                                <p className="text-sm font-bold text-red-800">Virus Detected</p>
                                <p className="text-xs text-red-700 mt-0.5">
                                    This file has been quarantined by ClamAV and cannot be viewed or downloaded.
                                </p>
                            </div>
                        </div>
                    )}

                    {/* Progress bar */}
                    {progress !== null && (
                        <div>
                            <div className="flex items-center justify-between mb-1.5">
                                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Processing Progress</p>
                                <span className="text-xs font-bold text-foreground">{progress}%</span>
                            </div>
                            <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                                <div
                                    className="h-full bg-primary rounded-full transition-all duration-500"
                                    style={{ width: `${progress}%` }}
                                />
                            </div>
                            <p className="text-xs text-muted-foreground mt-1">
                                {liveFile.chunks_processed} / {liveFile.chunks_total} chunks
                            </p>
                        </div>
                    )}

                    {/* Details grid */}
                    <div className="space-y-3">
                        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Details</p>
                        <div className="grid grid-cols-2 gap-3">
                            <div className="bg-muted/30 rounded-lg border border-border/50 p-3">
                                <p className="text-[10px] text-muted-foreground font-semibold uppercase">File ID</p>
                                <p className="text-xs font-mono text-foreground mt-0.5 break-all">{liveFile.id}</p>
                            </div>
                            <div className="bg-muted/30 rounded-lg border border-border/50 p-3">
                                <p className="text-[10px] text-muted-foreground font-semibold uppercase">Created</p>
                                <p className="text-xs text-foreground mt-0.5">{formatDate(liveFile.created_at)}</p>
                            </div>
                            <div className="bg-muted/30 rounded-lg border border-border/50 p-3">
                                <p className="text-[10px] text-muted-foreground font-semibold uppercase">MIME Type</p>
                                <p className="text-xs text-foreground mt-0.5">{liveFile.mime_type || "—"}</p>
                            </div>
                            <div className="bg-muted/30 rounded-lg border border-border/50 p-3">
                                <p className="text-[10px] text-muted-foreground font-semibold uppercase">Size</p>
                                <p className="text-xs text-foreground mt-0.5">{formatSize(liveFile.size)}</p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════

export default function FilesPage() {
    const router = useRouter();
    const { token, logout, isLoading: authLoading } = useAuth();
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Data
    const [files, setFiles] = useState<FileInfo[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [filter, setFilter] = useState("");

    // Upload
    const [uploading, setUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [uploadFileName, setUploadFileName] = useState<string | null>(null);

    // Drawer
    const [drawerFile, setDrawerFile] = useState<FileInfo | null>(null);

    // Actions
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);

    // Toast
    const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
    const showToast = useCallback((m: string, t: "success" | "error") => {
        setToast({ message: m, type: t });
        setTimeout(() => setToast(null), 4000);
    }, []);

    // ─── Load ───

    const loadFiles = useCallback(async () => {
        if (!token) return;
        setLoading(true);
        setError(null);
        try {
            const data = await fileApi.list(token, filter || undefined);
            setFiles(data);
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
    }, [token, logout, router, filter]);

    useEffect(() => {
        if (!authLoading && !token) { router.push("/login"); return; }
        if (token) loadFiles();
    }, [token, authLoading, router, loadFiles]);

    // ─── Upload (presigned) ───

    const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file || !token) return;
        e.target.value = "";

        setUploading(true);
        setUploadProgress(0);
        setUploadFileName(file.name);

        try {
            // Direct upload through gateway → file_service → MinIO
            await fileApi.directUpload(token, file, (pct) => {
                setUploadProgress(pct);
            });

            showToast(`"${file.name}" uploaded successfully`, "success");
            await loadFiles();
        } catch (err) {
            if (err instanceof Error) {
                showToast(err.message, "error");
            }
        } finally {
            setTimeout(() => {
                setUploading(false);
                setUploadProgress(0);
                setUploadFileName(null);
            }, 1000);
        }
    };

    // ─── Download ───

    const handleDownload = async (fileId: string) => {
        if (!token) return;
        try {
            const res = await fileApi.getViewUrl(token, fileId);
            window.open(res.url, "_blank");
        } catch (err) {
            if (err instanceof ApiRequestError) showToast(err.data.detail, "error");
        }
    };

    // ─── Delete ───

    const handleDelete = async (fileId: string) => {
        if (!token) return;
        setDeletingId(fileId);
        try {
            await fileApi.delete(token, fileId);
            showToast("File deleted", "success");
            setFiles((prev) => prev.filter((f) => f.id !== fileId));
        } catch (err) {
            if (err instanceof ApiRequestError) showToast(err.data.detail, "error");
        } finally {
            setDeletingId(null);
            setConfirmDelete(null);
        }
    };

    // ─── Use in Chat ───

    const handleUseInChat = (fileId: string) => {
        router.push(`/chat?file_ids=${fileId}`);
    };

    // ─── Render ───

    if (authLoading || loading) {
        return (
            <div className="min-h-screen bg-background flex items-center justify-center">
                <div className="flex flex-col items-center gap-3">
                    <RefreshCw className="h-6 w-6 text-primary animate-spin" />
                    <p className="text-sm text-muted-foreground font-medium">Loading files…</p>
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
                    <Button onClick={loadFiles} variant="outline">
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
                    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setConfirmDelete(null)} />
                    <div className="relative bg-card rounded-2xl border border-border shadow-2xl max-w-sm w-full p-6">
                        <div className="flex items-center gap-3 mb-4">
                            <div className="w-10 h-10 rounded-xl bg-red-50 flex items-center justify-center">
                                <Trash2 className="h-5 w-5 text-red-600" />
                            </div>
                            <div>
                                <h3 className="text-base font-bold text-foreground">Delete File</h3>
                                <p className="text-xs text-muted-foreground truncate max-w-[200px]">{confirmDelete.name}</p>
                            </div>
                        </div>
                        <p className="text-sm text-muted-foreground mb-5">
                            This file will be permanently removed. This action cannot be undone.
                        </p>
                        <div className="flex items-center gap-3 justify-end">
                            <Button variant="outline" onClick={() => setConfirmDelete(null)} className="text-sm font-semibold">
                                Cancel
                            </Button>
                            <Button
                                onClick={() => handleDelete(confirmDelete.id)}
                                disabled={deletingId === confirmDelete.id}
                                className="text-sm font-bold bg-red-600 hover:bg-red-700 text-white"
                            >
                                {deletingId === confirmDelete.id ? (
                                    <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                                ) : (
                                    <Trash2 className="h-4 w-4 mr-2" />
                                )}
                                Delete
                            </Button>
                        </div>
                    </div>
                </div>
            )}

            {/* Status Drawer */}
            {drawerFile && token && (
                <StatusDrawer file={drawerFile} onClose={() => setDrawerFile(null)} token={token} />
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
                        <span className="font-semibold text-foreground text-sm">Files</span>
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

                {/* ═══ UPLOAD SECTION ═══ */}
                <section>
                    <div className="flex items-center justify-between mb-5">
                        <div className="flex items-center gap-2.5">
                            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                                <FolderOpen className="h-4 w-4 text-primary" />
                            </div>
                            <div>
                                <h2 className="text-lg font-bold text-foreground">My Files</h2>
                                <p className="text-xs text-muted-foreground">
                                    {files.length} file{files.length !== 1 ? "s" : ""} · Upload documents for AI analysis
                                </p>
                            </div>
                        </div>
                    </div>

                    {/* Upload zone */}
                    <div className="bg-card rounded-2xl border-2 border-dashed border-border hover:border-primary/40 transition-colors shadow-sm overflow-hidden">
                        <input
                            ref={fileInputRef}
                            type="file"
                            className="hidden"
                            onChange={handleUpload}
                            accept=".pdf,.docx,.txt,.csv,.xlsx,.png,.jpg,.jpeg,.gif"
                        />

                        {uploading ? (
                            /* Upload progress */
                            <div className="px-8 py-8">
                                <div className="flex items-center gap-4">
                                    <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                                        <Upload className="h-5 w-5 text-primary animate-pulse" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-bold text-foreground truncate">{uploadFileName}</p>
                                        <div className="flex items-center gap-3 mt-2">
                                            <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                                                <div
                                                    className="h-full bg-primary rounded-full transition-all duration-300"
                                                    style={{ width: `${uploadProgress}%` }}
                                                />
                                            </div>
                                            <span className="text-xs font-bold text-primary shrink-0">{uploadProgress}%</span>
                                        </div>
                                        <p className="text-xs text-muted-foreground mt-1">
                                            {uploadProgress < 90 ? "Uploading to storage…" :
                                                uploadProgress < 100 ? "Completing upload…" : "Done!"}
                                        </p>
                                    </div>
                                </div>
                            </div>
                        ) : (
                            /* Drop zone */
                            <button
                                onClick={() => fileInputRef.current?.click()}
                                className="w-full px-8 py-10 flex flex-col items-center gap-3 cursor-pointer group"
                            >
                                <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center group-hover:bg-primary/20 transition-colors">
                                    <Upload className="h-6 w-6 text-primary" />
                                </div>
                                <div className="text-center">
                                    <p className="text-sm font-bold text-foreground">
                                        Click to upload a file
                                    </p>
                                    <p className="text-xs text-muted-foreground mt-1">
                                        PDF, DOCX, TXT, CSV, XLSX, PNG, JPEG, GIF — up to 100 MB
                                    </p>
                                </div>
                            </button>
                        )}
                    </div>
                </section>

                {/* ═══ FILTER BAR ═══ */}
                <div className="flex items-center gap-2 flex-wrap">
                    {FILTER_OPTIONS.map((opt) => (
                        <button
                            key={opt.value}
                            onClick={() => setFilter(opt.value)}
                            className={`px-3.5 py-1.5 rounded-full text-xs font-bold transition-all ${filter === opt.value
                                ? "bg-primary text-primary-foreground shadow-sm"
                                : "bg-muted text-muted-foreground hover:bg-muted/80"
                                }`}
                        >
                            {opt.label}
                        </button>
                    ))}
                    <Button
                        variant="outline" size="sm"
                        onClick={loadFiles}
                        className="ml-auto text-xs font-semibold"
                    >
                        <RefreshCw className="h-3 w-3 mr-1" /> Refresh
                    </Button>
                </div>

                {/* ═══ FILES TABLE ═══ */}
                <section>
                    <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
                        {/* Table header */}
                        <div className="hidden lg:grid grid-cols-12 gap-4 px-6 py-3 bg-muted/50 border-b border-border text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                            <div className="col-span-4">File</div>
                            <div className="col-span-1">Type</div>
                            <div className="col-span-1">Size</div>
                            <div className="col-span-2">Status</div>
                            <div className="col-span-2">Uploaded</div>
                            <div className="col-span-2 text-right">Actions</div>
                        </div>

                        {files.length === 0 ? (
                            <div className="px-6 py-16 text-center">
                                <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center mx-auto mb-4">
                                    <HardDrive className="h-7 w-7 text-muted-foreground/40" />
                                </div>
                                <h3 className="text-base font-bold text-foreground mb-1.5">No files yet</h3>
                                <p className="text-sm text-muted-foreground mb-5 max-w-xs mx-auto">
                                    Upload your first document to get started with AI-powered analysis.
                                </p>
                                <Button onClick={() => fileInputRef.current?.click()} className="font-bold text-sm shadow-sm">
                                    <Upload className="h-4 w-4 mr-1.5" />
                                    Upload File
                                </Button>
                            </div>
                        ) : (
                            <div className="divide-y divide-border">
                                {files.map((file) => {
                                    const Icon = mimeIcon(file.mime_type);
                                    const statusCfg = STATUS_CONFIG[file.status] || STATUS_CONFIG.error;
                                    const StatusIcon = statusCfg.icon;
                                    const isQuarantined = file.status === "quarantined";
                                    const isReady = file.status === "ready";
                                    const isProcessing = ["uploading", "scanning", "processing"].includes(file.status);
                                    const progress = file.chunks_total > 0
                                        ? Math.round((file.chunks_processed / file.chunks_total) * 100)
                                        : null;

                                    return (
                                        <div
                                            key={file.id}
                                            className={`grid grid-cols-1 lg:grid-cols-12 gap-3 lg:gap-4 px-6 py-4 items-center hover:bg-muted/20 transition-colors ${isQuarantined ? "bg-red-50/30" : ""
                                                }`}
                                        >
                                            {/* File name */}
                                            <div className="col-span-4 flex items-center gap-3 min-w-0">
                                                <button
                                                    onClick={() => setDrawerFile(file)}
                                                    className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center shrink-0 hover:bg-muted/80 transition-colors"
                                                >
                                                    <Icon className="h-5 w-5 text-muted-foreground" />
                                                </button>
                                                <button
                                                    onClick={() => setDrawerFile(file)}
                                                    className="min-w-0 flex-1 text-left"
                                                >
                                                    <p className="text-sm font-bold text-foreground truncate hover:text-primary transition-colors">
                                                        {file.filename}
                                                    </p>
                                                    {isProcessing && progress !== null && (
                                                        <div className="flex items-center gap-2 mt-1">
                                                            <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden max-w-[120px]">
                                                                <div
                                                                    className="h-full bg-primary rounded-full transition-all"
                                                                    style={{ width: `${progress}%` }}
                                                                />
                                                            </div>
                                                            <span className="text-[10px] font-bold text-muted-foreground">{progress}%</span>
                                                        </div>
                                                    )}
                                                </button>
                                            </div>

                                            {/* Type */}
                                            <div className="col-span-1">
                                                <span className="inline-flex text-[11px] font-bold text-muted-foreground bg-muted rounded-md px-2 py-0.5 uppercase">
                                                    {mimeLabel(file.mime_type)}
                                                </span>
                                            </div>

                                            {/* Size */}
                                            <div className="col-span-1">
                                                <span className="text-sm text-muted-foreground">{formatSize(file.size)}</span>
                                            </div>

                                            {/* Status */}
                                            <div className="col-span-2">
                                                <span className={`inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full ${statusCfg.bg} ${statusCfg.text}`}>
                                                    <StatusIcon className="h-3 w-3" />
                                                    {statusCfg.label}
                                                </span>
                                                {isQuarantined && (
                                                    <p className="text-[10px] text-red-600 font-medium mt-0.5">⚠ Virus detected</p>
                                                )}
                                            </div>

                                            {/* Uploaded */}
                                            <div className="col-span-2">
                                                <div className="flex items-center gap-1.5">
                                                    <Clock className="h-3 w-3 text-muted-foreground" />
                                                    <span className="text-sm text-muted-foreground">{formatDate(file.created_at)}</span>
                                                </div>
                                            </div>

                                            {/* Actions */}
                                            <div className="col-span-2 flex items-center gap-1.5 justify-end flex-wrap">
                                                {/* View/Download */}
                                                {isReady && (
                                                    <Button
                                                        variant="outline" size="sm"
                                                        onClick={() => handleDownload(file.id)}
                                                        className="text-xs font-semibold"
                                                    >
                                                        <Eye className="h-3 w-3 mr-1" /> View
                                                    </Button>
                                                )}

                                                {/* Use in Chat */}
                                                {isReady && (
                                                    <Button
                                                        variant="outline" size="sm"
                                                        onClick={() => handleUseInChat(file.id)}
                                                        className="text-xs font-semibold border-primary/20 text-primary hover:bg-primary/5"
                                                    >
                                                        <MessageSquare className="h-3 w-3 mr-1" /> Chat
                                                    </Button>
                                                )}

                                                {/* Status detail */}
                                                <Button
                                                    variant="outline" size="sm"
                                                    onClick={() => setDrawerFile(file)}
                                                    className="text-xs font-semibold"
                                                >
                                                    <Search className="h-3 w-3" />
                                                </Button>

                                                {/* Delete */}
                                                <Button
                                                    variant="outline" size="sm"
                                                    onClick={() => setConfirmDelete({ id: file.id, name: file.filename })}
                                                    disabled={deletingId === file.id}
                                                    className="text-xs font-semibold text-destructive border-destructive/20 hover:bg-destructive/5"
                                                >
                                                    {deletingId === file.id ? (
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

                {/* ═══ INFO BAR ═══ */}
                <section className="pb-12">
                    <div className="bg-card rounded-2xl border border-border shadow-sm p-8">
                        <div className="flex items-center gap-2.5 mb-5">
                            <div className="w-8 h-8 rounded-lg bg-violet-500/10 flex items-center justify-center">
                                <HardDrive className="h-4 w-4 text-violet-600" />
                            </div>
                            <h2 className="text-lg font-bold text-foreground">File Pipeline</h2>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                            <div className="bg-muted/30 rounded-xl border border-border/50 p-4 text-center">
                                <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center mx-auto mb-2">
                                    <Upload className="h-4 w-4 text-blue-600" />
                                </div>
                                <p className="text-xs font-bold text-foreground">Upload</p>
                                <p className="text-[10px] text-muted-foreground mt-0.5">Presigned URL to MinIO</p>
                            </div>
                            <div className="bg-muted/30 rounded-xl border border-border/50 p-4 text-center">
                                <div className="w-8 h-8 rounded-lg bg-amber-50 flex items-center justify-center mx-auto mb-2">
                                    <ShieldAlert className="h-4 w-4 text-amber-600" />
                                </div>
                                <p className="text-xs font-bold text-foreground">ClamAV Scan</p>
                                <p className="text-[10px] text-muted-foreground mt-0.5">Virus detection</p>
                            </div>
                            <div className="bg-muted/30 rounded-xl border border-border/50 p-4 text-center">
                                <div className="w-8 h-8 rounded-lg bg-violet-50 flex items-center justify-center mx-auto mb-2">
                                    <Search className="h-4 w-4 text-violet-600" />
                                </div>
                                <p className="text-xs font-bold text-foreground">RAG Indexing</p>
                                <p className="text-[10px] text-muted-foreground mt-0.5">Parse · Chunk · Embed</p>
                            </div>
                            <div className="bg-muted/30 rounded-xl border border-border/50 p-4 text-center">
                                <div className="w-8 h-8 rounded-lg bg-emerald-50 flex items-center justify-center mx-auto mb-2">
                                    <FileCheck className="h-4 w-4 text-emerald-600" />
                                </div>
                                <p className="text-xs font-bold text-foreground">Ready</p>
                                <p className="text-[10px] text-muted-foreground mt-0.5">Search & Chat enabled</p>
                            </div>
                        </div>
                    </div>
                </section>
            </main>
        </div>
    );
}
