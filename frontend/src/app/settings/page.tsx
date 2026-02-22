"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
    User,
    Shield,
    Monitor,
    Clock,
    Key,
    LogOut,
    CheckCircle2,
    XCircle,
    AlertTriangle,
    Eye,
    EyeOff,
    ChevronRight,
    RefreshCw,
    Trash2,
    LayoutGrid,
    Building2,
    BadgeCheck,
    CircleDot,
    Smartphone,
    Globe,
    Info,
    Lock,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { authApi, ApiRequestError } from "@/lib/api";
import type { SessionInfo, LoginActivityItem } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// ─── Types ───

interface ProfileData {
    id: string;
    email: string;
    full_name: string;
    role: string;
    roles: string[];
    tenant_id: string | null;
    tenant_name: string | null;
    status: string;
    mfa_enabled: boolean;
    created_at: string | null;
    last_login_at: string | null;
    last_login_ip: string | null;
}

// ─── Helpers ───

function formatDate(iso: string | null): string {
    if (!iso) return "—";
    // Ensure UTC interpretation if no timezone indicator
    const utcIso = iso.includes("Z") || iso.includes("+") ? iso : iso + "Z";
    const d = new Date(utcIso);
    return d.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function parseDevice(ua: string | null): { label: string; icon: "desktop" | "mobile" } {
    if (!ua) return { label: "Unknown device", icon: "desktop" };
    const lower = ua.toLowerCase();
    if (lower.includes("mobile") || lower.includes("android") || lower.includes("iphone"))
        return { label: ua.length > 60 ? ua.substring(0, 57) + "…" : ua, icon: "mobile" };
    return { label: ua.length > 60 ? ua.substring(0, 57) + "…" : ua, icon: "desktop" };
}

// ─── Password Rules ───

const PASSWORD_RULES = [
    { key: "length", label: "At least 12 characters", test: (p: string) => p.length >= 12 },
    { key: "upper", label: "One uppercase letter", test: (p: string) => /[A-Z]/.test(p) },
    { key: "lower", label: "One lowercase letter", test: (p: string) => /[a-z]/.test(p) },
    { key: "digit", label: "One number", test: (p: string) => /\d/.test(p) },
    { key: "special", label: "One special character", test: (p: string) => /[!@#$%^&*()_+\-=\[\]{}|;:,.<>?/~`]/.test(p) },
];

// ═══════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════

export default function AccountSettingsPage() {
    const router = useRouter();
    const { token, logout, isLoading: authLoading } = useAuth();

    // State
    const [profile, setProfile] = useState<ProfileData | null>(null);
    const [sessions, setSessions] = useState<SessionInfo[]>([]);
    const [activity, setActivity] = useState<LoginActivityItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Password form
    const [oldPassword, setOldPassword] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [showOld, setShowOld] = useState(false);
    const [showNew, setShowNew] = useState(false);
    const [pwChanging, setPwChanging] = useState(false);
    const [pwSuccess, setPwSuccess] = useState<string | null>(null);
    const [pwError, setPwError] = useState<string | null>(null);

    // Session actions
    const [revokingId, setRevokingId] = useState<string | null>(null);
    const [logoutAllLoading, setLogoutAllLoading] = useState(false);

    // Toast
    const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);

    const showToast = useCallback((message: string, type: "success" | "error") => {
        setToast({ message, type });
        setTimeout(() => setToast(null), 4000);
    }, []);

    // ─── Load data ───

    const loadData = useCallback(async () => {
        if (!token) return;
        setLoading(true);
        setError(null);
        try {
            const [profileRes, sessionsRes, activityRes] = await Promise.all([
                authApi.me(token),
                authApi.getSessions(token),
                authApi.getLoginActivity(token, 50),
            ]);
            setProfile(profileRes as unknown as ProfileData);
            setSessions(sessionsRes);
            setActivity(activityRes);
        } catch (err) {
            if (err instanceof ApiRequestError) {
                if (err.status === 401) {
                    await logout();
                    router.push("/login");
                    return;
                }
                setError(err.message);
            } else {
                setError("Cannot connect to server");
            }
        } finally {
            setLoading(false);
        }
    }, [token, logout, router]);

    useEffect(() => {
        if (!authLoading && !token) {
            router.push("/login");
            return;
        }
        if (token) loadData();
    }, [token, authLoading, router, loadData]);

    // ─── Change password ───

    const handleChangePassword = async (e: React.FormEvent) => {
        e.preventDefault();
        setPwError(null);
        setPwSuccess(null);

        if (newPassword !== confirmPassword) {
            setPwError("Passwords do not match");
            return;
        }

        if (!token) return;
        setPwChanging(true);
        try {
            const res = await authApi.changePassword(token, {
                old_password: oldPassword,
                new_password: newPassword,
            });
            if (res.sessions_revoked) {
                showToast("Password changed! Redirecting to login…", "success");
                setTimeout(async () => {
                    await logout();
                    router.push("/login");
                }, 2000);
            } else {
                setPwSuccess(res.message);
                setOldPassword("");
                setNewPassword("");
                setConfirmPassword("");
            }
        } catch (err) {
            if (err instanceof ApiRequestError) {
                setPwError(err.data.detail);
            } else {
                setPwError("Something went wrong");
            }
        } finally {
            setPwChanging(false);
        }
    };

    // ─── Revoke session ───

    const handleRevokeSession = async (sessionId: string) => {
        if (!token) return;
        setRevokingId(sessionId);
        try {
            await authApi.revokeSession(token, sessionId);
            showToast("Session revoked", "success");
            setSessions((prev) =>
                prev.map((s) =>
                    s.id === sessionId ? { ...s, status: "revoked", revoked_at: new Date().toISOString() } : s
                )
            );
        } catch (err) {
            if (err instanceof ApiRequestError) {
                showToast(err.data.detail, "error");
            }
        } finally {
            setRevokingId(null);
        }
    };

    // ─── Logout all ───

    const handleLogoutAll = async () => {
        if (!token) return;
        setLogoutAllLoading(true);
        try {
            const res = await authApi.logoutAll(token);
            showToast(`${res.revoked_count} sessions revoked. Redirecting…`, "success");
            setTimeout(async () => {
                await logout();
                router.push("/login");
            }, 2000);
        } catch (err) {
            if (err instanceof ApiRequestError) {
                showToast(err.data.detail, "error");
            }
        } finally {
            setLogoutAllLoading(false);
        }
    };

    // ─── Render ───

    if (authLoading || loading) {
        return (
            <div className="min-h-screen bg-background flex items-center justify-center">
                <div className="flex flex-col items-center gap-3">
                    <RefreshCw className="h-6 w-6 text-primary animate-spin" />
                    <p className="text-sm text-muted-foreground font-medium">Loading account settings…</p>
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
                        <RefreshCw className="h-4 w-4 mr-2" />
                        Retry
                    </Button>
                </div>
            </div>
        );
    }

    if (!profile) return null;

    const activeSessions = sessions.filter((s) => s.status === "active");
    const pwValid = PASSWORD_RULES.every((r) => r.test(newPassword));
    const pwMatch = newPassword === confirmPassword && confirmPassword.length > 0;
    const canSubmitPw = oldPassword.length > 0 && pwValid && pwMatch;

    return (
        <div className="min-h-screen bg-background">
            {/* Toast */}
            {toast && (
                <div className="fixed top-6 right-6 z-50 animate-in slide-in-from-top-2 fade-in duration-300">
                    <div
                        className={`flex items-center gap-3 px-5 py-3.5 rounded-xl shadow-lg border ${toast.type === "success"
                            ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                            : "bg-red-50 border-red-200 text-red-800"
                            }`}
                    >
                        {toast.type === "success" ? (
                            <CheckCircle2 className="h-4 w-4 shrink-0" />
                        ) : (
                            <XCircle className="h-4 w-4 shrink-0" />
                        )}
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
                        <span className="font-semibold text-foreground text-sm">Account Settings</span>
                    </div>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={async () => {
                            await logout();
                            router.push("/login");
                        }}
                        className="text-xs font-semibold"
                    >
                        <LogOut className="h-3.5 w-3.5 mr-1.5" />
                        Sign Out
                    </Button>
                </div>
            </header>

            <main className="max-w-6xl mx-auto px-6 py-8 space-y-8">
                {/* ═══ SECTION 1: PROFILE CARD ═══ */}
                <section>
                    <div className="flex items-center gap-2.5 mb-5">
                        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                            <User className="h-4 w-4 text-primary" />
                        </div>
                        <h2 className="text-lg font-bold text-foreground">Profile</h2>
                    </div>

                    <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
                        {/* Top bar with avatar */}
                        <div className="px-8 pt-8 pb-6 flex items-start gap-5">
                            <div className="w-16 h-16 rounded-full bg-gradient-to-br from-primary to-blue-400 flex items-center justify-center text-white text-xl font-bold shrink-0 shadow-md">
                                {profile.full_name
                                    ? profile.full_name
                                        .split(" ")
                                        .map((n) => n[0])
                                        .join("")
                                        .toUpperCase()
                                        .slice(0, 2)
                                    : profile.email[0].toUpperCase()}
                            </div>
                            <div className="flex-1 min-w-0">
                                <h3 className="text-xl font-bold text-foreground truncate">
                                    {profile.full_name || "No name set"}
                                </h3>
                                <p className="text-muted-foreground text-sm mt-0.5">{profile.email}</p>
                                <div className="flex flex-wrap items-center gap-2 mt-3">
                                    {profile.roles.map((r) => (
                                        <span
                                            key={r}
                                            className="inline-flex items-center rounded-full bg-primary/10 text-primary text-xs font-bold px-3 py-1 uppercase tracking-wide"
                                        >
                                            {r}
                                        </span>
                                    ))}
                                    <span
                                        className={`inline-flex items-center rounded-full text-xs font-bold px-3 py-1 ${profile.status === "active"
                                            ? "bg-emerald-50 text-emerald-700"
                                            : "bg-red-50 text-red-700"
                                            }`}
                                    >
                                        <CircleDot className="h-3 w-3 mr-1" />
                                        {profile.status}
                                    </span>
                                    <span
                                        className={`inline-flex items-center rounded-full text-xs font-bold px-3 py-1 ${profile.mfa_enabled
                                            ? "bg-emerald-50 text-emerald-700"
                                            : "bg-amber-50 text-amber-700"
                                            }`}
                                    >
                                        <Shield className="h-3 w-3 mr-1" />
                                        MFA {profile.mfa_enabled ? "Enabled" : "Disabled"}
                                    </span>
                                </div>
                            </div>
                        </div>

                        {/* Info grid */}
                        <div className="border-t border-border px-8 py-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
                            <div>
                                <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wider mb-1">
                                    Organization
                                </p>
                                <div className="flex items-center gap-1.5">
                                    <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                                    <span className="text-sm font-bold text-foreground">
                                        {profile.tenant_name || "—"}
                                    </span>
                                </div>
                            </div>

                            <div>
                                <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wider mb-1">
                                    Member Since
                                </p>
                                <div className="flex items-center gap-1.5">
                                    <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                                    <span className="text-sm font-bold text-foreground">
                                        {formatDate(profile.created_at)}
                                    </span>
                                </div>
                            </div>

                            <div>
                                <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wider mb-1">
                                    Last Login
                                </p>
                                <div className="flex items-center gap-1.5">
                                    <BadgeCheck className="h-3.5 w-3.5 text-muted-foreground" />
                                    <span className="text-sm font-bold text-foreground">
                                        {formatDate(profile.last_login_at)}
                                    </span>
                                </div>
                            </div>

                            <div>
                                <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wider mb-1">
                                    Last IP Address
                                </p>
                                <div className="flex items-center gap-1.5">
                                    <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                                    <span className="text-sm font-bold text-foreground font-mono text-xs">
                                        {profile.last_login_ip || "—"}
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>
                </section>

                {/* ═══ SECTION 2: CHANGE PASSWORD ═══ */}
                <section>
                    <div className="flex items-center gap-2.5 mb-5">
                        <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center">
                            <Key className="h-4 w-4 text-amber-600" />
                        </div>
                        <h2 className="text-lg font-bold text-foreground">Change Password</h2>
                    </div>

                    <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
                        <form onSubmit={handleChangePassword} className="p-8">
                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                                {/* Left: form */}
                                <div className="space-y-5">
                                    {/* Current password */}
                                    <div>
                                        <Label htmlFor="old-pw" className="text-sm font-semibold mb-1.5 block">
                                            Current Password
                                        </Label>
                                        <div className="relative">
                                            <Input
                                                id="old-pw"
                                                type={showOld ? "text" : "password"}
                                                value={oldPassword}
                                                onChange={(e) => setOldPassword(e.target.value)}
                                                placeholder="Enter current password"
                                                className="h-11 pr-10"
                                            />
                                            <button
                                                type="button"
                                                onClick={() => setShowOld(!showOld)}
                                                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                                            >
                                                {showOld ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                            </button>
                                        </div>
                                    </div>

                                    {/* New password */}
                                    <div>
                                        <Label htmlFor="new-pw" className="text-sm font-semibold mb-1.5 block">
                                            New Password
                                        </Label>
                                        <div className="relative">
                                            <Input
                                                id="new-pw"
                                                type={showNew ? "text" : "password"}
                                                value={newPassword}
                                                onChange={(e) => setNewPassword(e.target.value)}
                                                placeholder="Enter new password"
                                                className="h-11 pr-10"
                                            />
                                            <button
                                                type="button"
                                                onClick={() => setShowNew(!showNew)}
                                                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                                            >
                                                {showNew ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                            </button>
                                        </div>
                                    </div>

                                    {/* Confirm password */}
                                    <div>
                                        <Label htmlFor="confirm-pw" className="text-sm font-semibold mb-1.5 block">
                                            Confirm New Password
                                        </Label>
                                        <Input
                                            id="confirm-pw"
                                            type="password"
                                            value={confirmPassword}
                                            onChange={(e) => setConfirmPassword(e.target.value)}
                                            placeholder="Re-enter new password"
                                            className="h-11"
                                        />
                                        {confirmPassword.length > 0 && !pwMatch && (
                                            <p className="text-xs text-destructive mt-1.5 font-medium flex items-center gap-1">
                                                <XCircle className="h-3 w-3" />
                                                Passwords do not match
                                            </p>
                                        )}
                                    </div>

                                    {/* Error / Success */}
                                    {pwError && (
                                        <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm font-medium">
                                            <XCircle className="h-4 w-4 shrink-0" />
                                            {pwError}
                                        </div>
                                    )}
                                    {pwSuccess && (
                                        <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm font-medium">
                                            <CheckCircle2 className="h-4 w-4 shrink-0" />
                                            {pwSuccess}
                                        </div>
                                    )}

                                    <Button
                                        type="submit"
                                        disabled={!canSubmitPw || pwChanging}
                                        className="h-11 w-full sm:w-auto px-8 font-bold text-sm shadow-sm"
                                    >
                                        {pwChanging ? (
                                            <>
                                                <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                                                Changing…
                                            </>
                                        ) : (
                                            <>
                                                <Lock className="h-4 w-4 mr-2" />
                                                Change Password
                                            </>
                                        )}
                                    </Button>
                                </div>

                                {/* Right: policy hints */}
                                <div>
                                    <div className="bg-muted/50 rounded-xl border border-border/50 p-5">
                                        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                                            Password Requirements
                                        </p>
                                        <ul className="space-y-2.5">
                                            {PASSWORD_RULES.map((rule) => {
                                                const passed = newPassword.length > 0 && rule.test(newPassword);
                                                return (
                                                    <li key={rule.key} className="flex items-center gap-2">
                                                        {newPassword.length === 0 ? (
                                                            <div className="w-4 h-4 rounded-full border-2 border-border" />
                                                        ) : passed ? (
                                                            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                                                        ) : (
                                                            <XCircle className="h-4 w-4 text-red-400" />
                                                        )}
                                                        <span
                                                            className={`text-sm ${newPassword.length === 0
                                                                ? "text-muted-foreground"
                                                                : passed
                                                                    ? "text-emerald-700 font-medium"
                                                                    : "text-red-500"
                                                                }`}
                                                        >
                                                            {rule.label}
                                                        </span>
                                                    </li>
                                                );
                                            })}
                                        </ul>

                                        <div className="mt-5 pt-4 border-t border-border/50">
                                            <div className="flex items-start gap-2">
                                                <Info className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                                                <p className="text-xs text-muted-foreground leading-relaxed">
                                                    Changing your password will <span className="font-bold text-foreground">
                                                        sign you out of all devices
                                                    </span>. You will need to log in again.
                                                </p>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </form>
                    </div>
                </section>

                {/* ═══ SECTION 3: ACTIVE SESSIONS ═══ */}
                <section>
                    <div className="flex items-center justify-between mb-5">
                        <div className="flex items-center gap-2.5">
                            <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                                <Monitor className="h-4 w-4 text-emerald-600" />
                            </div>
                            <div>
                                <h2 className="text-lg font-bold text-foreground">Active Sessions</h2>
                                <p className="text-xs text-muted-foreground">
                                    {activeSessions.length} active session{activeSessions.length !== 1 ? "s" : ""}
                                </p>
                            </div>
                        </div>
                        {activeSessions.length > 1 && (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={handleLogoutAll}
                                disabled={logoutAllLoading}
                                className="text-xs font-bold text-destructive border-destructive/30 hover:bg-destructive/5 hover:border-destructive/50"
                            >
                                {logoutAllLoading ? (
                                    <RefreshCw className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                ) : (
                                    <LogOut className="h-3.5 w-3.5 mr-1.5" />
                                )}
                                Sign out all devices
                            </Button>
                        )}
                    </div>

                    <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
                        {/* Table header */}
                        <div className="hidden sm:grid grid-cols-12 gap-4 px-6 py-3 bg-muted/50 border-b border-border text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                            <div className="col-span-4">Device</div>
                            <div className="col-span-2">IP Address</div>
                            <div className="col-span-2">Signed In</div>
                            <div className="col-span-2">Last Active</div>
                            <div className="col-span-2 text-right">Action</div>
                        </div>

                        {/* Session rows */}
                        {sessions.length === 0 ? (
                            <div className="px-6 py-12 text-center">
                                <Monitor className="h-8 w-8 text-muted-foreground/40 mx-auto mb-3" />
                                <p className="text-sm text-muted-foreground">No sessions found</p>
                            </div>
                        ) : (
                            <div className="divide-y divide-border">
                                {sessions.map((session) => {
                                    const device = parseDevice(session.user_agent);
                                    const isActive = session.status === "active";
                                    const isRevoking = revokingId === session.id;

                                    return (
                                        <div
                                            key={session.id}
                                            className={`grid grid-cols-1 sm:grid-cols-12 gap-2 sm:gap-4 px-6 py-4 items-center transition-colors ${!isActive ? "opacity-50" : ""
                                                } ${session.is_current ? "bg-primary/[0.02]" : ""}`}
                                        >
                                            {/* Device */}
                                            <div className="col-span-4 flex items-center gap-3 min-w-0">
                                                <div
                                                    className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${session.is_current
                                                        ? "bg-primary/10"
                                                        : "bg-muted"
                                                        }`}
                                                >
                                                    {device.icon === "mobile" ? (
                                                        <Smartphone className={`h-4 w-4 ${session.is_current ? "text-primary" : "text-muted-foreground"}`} />
                                                    ) : (
                                                        <Monitor className={`h-4 w-4 ${session.is_current ? "text-primary" : "text-muted-foreground"}`} />
                                                    )}
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                    <p className="text-sm font-semibold text-foreground truncate">{device.label}</p>
                                                    <div className="flex items-center gap-2 mt-0.5">
                                                        {session.is_current && (
                                                            <span className="inline-flex items-center text-[10px] font-bold text-primary bg-primary/10 rounded-full px-2 py-0.5 uppercase tracking-wide">
                                                                This device
                                                            </span>
                                                        )}
                                                        {!isActive && (
                                                            <span className="inline-flex items-center text-[10px] font-bold text-muted-foreground bg-muted rounded-full px-2 py-0.5">
                                                                Revoked
                                                            </span>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>

                                            {/* IP */}
                                            <div className="col-span-2">
                                                <span className="text-sm font-mono text-muted-foreground">
                                                    {session.ip || "—"}
                                                </span>
                                            </div>

                                            {/* Created */}
                                            <div className="col-span-2">
                                                <span className="text-sm text-muted-foreground">{formatDate(session.created_at)}</span>
                                            </div>

                                            {/* Last seen */}
                                            <div className="col-span-2">
                                                <span className="text-sm text-muted-foreground">
                                                    {isActive ? formatDate(session.last_seen) : formatDate(session.revoked_at)}
                                                </span>
                                            </div>

                                            {/* Action */}
                                            <div className="col-span-2 flex justify-end">
                                                {isActive && !session.is_current ? (
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() => handleRevokeSession(session.id)}
                                                        disabled={isRevoking}
                                                        className="text-xs font-semibold text-destructive border-destructive/20 hover:bg-destructive/5"
                                                    >
                                                        {isRevoking ? (
                                                            <RefreshCw className="h-3 w-3 animate-spin" />
                                                        ) : (
                                                            <Trash2 className="h-3 w-3 mr-1" />
                                                        )}
                                                        Revoke
                                                    </Button>
                                                ) : session.is_current ? (
                                                    <span className="text-xs text-muted-foreground font-medium italic">Current</span>
                                                ) : null}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </section>

                {/* ═══ SECTION 4: LOGIN ACTIVITY ═══ */}
                <section className="pb-12">
                    <div className="flex items-center gap-2.5 mb-5">
                        <div className="w-8 h-8 rounded-lg bg-violet-500/10 flex items-center justify-center">
                            <Clock className="h-4 w-4 text-violet-600" />
                        </div>
                        <div>
                            <h2 className="text-lg font-bold text-foreground">Login Activity</h2>
                            <p className="text-xs text-muted-foreground">Recent login attempts (last 50)</p>
                        </div>
                    </div>

                    <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
                        {/* Table header */}
                        <div className="hidden sm:grid grid-cols-12 gap-4 px-6 py-3 bg-muted/50 border-b border-border text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                            <div className="col-span-3">Time</div>
                            <div className="col-span-2">Status</div>
                            <div className="col-span-2">IP Address</div>
                            <div className="col-span-5">Device / Details</div>
                        </div>

                        {activity.length === 0 ? (
                            <div className="px-6 py-12 text-center">
                                <Clock className="h-8 w-8 text-muted-foreground/40 mx-auto mb-3" />
                                <p className="text-sm text-muted-foreground">No login activity recorded</p>
                            </div>
                        ) : (
                            <div className="divide-y divide-border">
                                {activity.map((item, idx) => {
                                    const isSuccess = item.action === "LOGIN_SUCCESS";
                                    return (
                                        <div
                                            key={idx}
                                            className="grid grid-cols-1 sm:grid-cols-12 gap-2 sm:gap-4 px-6 py-3.5 items-center hover:bg-muted/30 transition-colors"
                                        >
                                            {/* Time */}
                                            <div className="col-span-3">
                                                <span className="text-sm text-foreground font-medium">
                                                    {formatDate(item.timestamp)}
                                                </span>
                                            </div>

                                            {/* Status badge */}
                                            <div className="col-span-2">
                                                <span
                                                    className={`inline-flex items-center rounded-full text-[11px] font-bold px-2.5 py-1 ${isSuccess
                                                        ? "bg-emerald-50 text-emerald-700"
                                                        : "bg-red-50 text-red-700"
                                                        }`}
                                                >
                                                    {isSuccess ? (
                                                        <CheckCircle2 className="h-3 w-3 mr-1" />
                                                    ) : (
                                                        <XCircle className="h-3 w-3 mr-1" />
                                                    )}
                                                    {isSuccess ? "Success" : "Failed"}
                                                </span>
                                            </div>

                                            {/* IP */}
                                            <div className="col-span-2">
                                                <span className="text-sm font-mono text-muted-foreground">
                                                    {item.ip || "—"}
                                                </span>
                                            </div>

                                            {/* Device / Detail */}
                                            <div className="col-span-5">
                                                <p className="text-sm text-muted-foreground truncate">
                                                    {item.detail || item.user_agent || "—"}
                                                </p>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </section>
            </main>
        </div>
    );
}
