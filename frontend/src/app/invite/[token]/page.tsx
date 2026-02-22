"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useRouter, useParams } from "next/navigation";
import {
    LayoutGrid,
    Lock,
    Eye,
    EyeOff,
    ArrowRight,
    CheckCircle2,
    Circle,
    AlertCircle,
    Loader2,
    ShieldAlert,
    Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useAuth, ApiRequestError } from "@/lib/auth-context";

interface InviteInfo {
    valid: boolean;
    email: string | null;
    tenant_name: string;
    role: string;
    expires_at: string;
}

export default function AcceptInvitePage() {
    const router = useRouter();
    const params = useParams();
    const token = params.token as string;
    const { login } = useAuth();

    // Invite verification state
    const [inviteInfo, setInviteInfo] = useState<InviteInfo | null>(null);
    const [verifyError, setVerifyError] = useState<{ status: number; message: string } | null>(null);
    const [isVerifying, setIsVerifying] = useState(true);

    // Form state
    const [email, setEmail] = useState("");
    const [fullName, setFullName] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [showConfirm, setShowConfirm] = useState(false);
    const [acceptTerms, setAcceptTerms] = useState(false);

    // Submit state
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState("");
    const [success, setSuccess] = useState(false);

    const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

    // ─── Verify invite on mount ───
    const verifyInvite = useCallback(async () => {
        try {
            const resp = await fetch(`${API_BASE}/auth/invites/${token}`);
            const data = await resp.json().catch(() => ({ detail: "Unknown error" }));

            if (!resp.ok) {
                setVerifyError({ status: resp.status, message: data.detail });
                return;
            }

            setInviteInfo(data);
            if (data.email) {
                setEmail(data.email);
            }
        } catch {
            setVerifyError({ status: 0, message: "Cannot connect to server" });
        } finally {
            setIsVerifying(false);
        }
    }, [API_BASE, token]);

    useEffect(() => {
        verifyInvite();
    }, [verifyInvite]);

    // ─── Password validation rules ───
    const pwRules = {
        length: password.length >= 12,
        mix: /(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9])/.test(password),
        noEmail: !email || !password.toLowerCase().includes(email.split("@")[0]?.toLowerCase() || ""),
    };
    const allPwValid = pwRules.length && pwRules.mix && pwRules.noEmail;
    const passwordsMatch = password === confirmPassword && confirmPassword.length > 0;

    // ─── Submit ───
    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (isSubmitting || !allPwValid || !passwordsMatch || !acceptTerms) return;

        setIsSubmitting(true);
        setSubmitError("");

        try {
            const resp = await fetch(`${API_BASE}/auth/invites/${token}/accept`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({
                    email: email.toLowerCase().trim(),
                    password,
                    full_name: fullName,
                }),
            });

            const data = await resp.json().catch(() => ({ detail: "Unknown error" }));

            if (!resp.ok) {
                throw new ApiRequestError(resp.status, data);
            }

            // Store token + user
            const storage = localStorage;
            storage.setItem("access_token", data.access_token);
            storage.setItem("user_data", JSON.stringify(data.user));

            setSuccess(true);
            setTimeout(() => router.push("/dashboard"), 1000);
        } catch (err) {
            if (err instanceof ApiRequestError) {
                setSubmitError(err.data.detail || `Registration failed (${err.status})`);
            } else {
                setSubmitError("Cannot connect to server. Please try again.");
            }
        } finally {
            setIsSubmitting(false);
        }
    }

    // ─── Loading state ───
    if (isVerifying) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-background">
                <div className="flex flex-col items-center gap-4">
                    <Loader2 className="h-8 w-8 animate-spin text-primary" />
                    <p className="text-muted-foreground text-sm font-medium">Verifying invite...</p>
                </div>
            </div>
        );
    }

    // ─── Error states ───
    if (verifyError) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-background p-4">
                <div className="w-full max-w-[420px] bg-card rounded-2xl shadow-xl border border-border overflow-hidden text-center p-10">
                    {verifyError.status === 404 ? (
                        <>
                            <ShieldAlert className="h-12 w-12 text-destructive mx-auto mb-4" />
                            <h2 className="text-xl font-bold text-foreground mb-2">Invalid Invite</h2>
                            <p className="text-muted-foreground text-sm">{verifyError.message}</p>
                        </>
                    ) : verifyError.status === 410 ? (
                        <>
                            <Clock className="h-12 w-12 text-amber-500 mx-auto mb-4" />
                            <h2 className="text-xl font-bold text-foreground mb-2">Invite Expired</h2>
                            <p className="text-muted-foreground text-sm">This invitation has expired. Please contact your administrator for a new one.</p>
                        </>
                    ) : verifyError.status === 409 ? (
                        <>
                            <AlertCircle className="h-12 w-12 text-amber-500 mx-auto mb-4" />
                            <h2 className="text-xl font-bold text-foreground mb-2">Invite Already Used</h2>
                            <p className="text-muted-foreground text-sm">{verifyError.message}</p>
                        </>
                    ) : (
                        <>
                            <AlertCircle className="h-12 w-12 text-destructive mx-auto mb-4" />
                            <h2 className="text-xl font-bold text-foreground mb-2">Something went wrong</h2>
                            <p className="text-muted-foreground text-sm">{verifyError.message}</p>
                        </>
                    )}
                    <Button
                        variant="outline"
                        className="mt-6"
                        onClick={() => router.push("/login")}
                    >
                        Back to Login
                    </Button>
                </div>
            </div>
        );
    }

    // ─── Main form ───
    return (
        <div className="min-h-screen flex flex-col bg-background">
            {/* Background decorative gradients */}
            <div className="fixed top-0 left-0 w-full h-full pointer-events-none -z-10 overflow-hidden">
                <div className="absolute top-[-10%] right-[-5%] w-[40%] h-[40%] rounded-full bg-primary/5 blur-[120px]" />
                <div className="absolute bottom-[-10%] left-[-5%] w-[30%] h-[30%] rounded-full bg-blue-400/5 blur-[100px]" />
            </div>

            <main className="flex-grow flex items-center justify-center p-4 sm:p-6 lg:p-8">
                <div className="w-full max-w-[520px] bg-card rounded-2xl shadow-xl overflow-hidden border border-border">
                    {/* Header Section */}
                    <div className="px-8 pt-10 pb-6 text-center">
                        <div className="flex justify-center mb-6">
                            <div className="flex items-center gap-2">
                                <div className="w-10 h-10 rounded-lg bg-primary flex items-center justify-center text-primary-foreground">
                                    <LayoutGrid className="h-5 w-5" />
                                </div>
                                <h2 className="text-xl font-bold tracking-tight text-foreground">Enterprise AI Platform</h2>
                            </div>
                        </div>

                        <div className="inline-flex items-center justify-center gap-x-2 rounded-full bg-muted py-1.5 px-4 mb-6 border border-border">
                            <Lock className="h-4 w-4 text-muted-foreground" />
                            <span className="text-muted-foreground text-xs font-semibold uppercase tracking-wide">Invitation Required</span>
                        </div>

                        <h1 className="text-3xl font-extrabold text-foreground mb-2 tracking-tight">
                            You&apos;re invited to join {inviteInfo?.tenant_name}
                        </h1>
                        <p className="text-muted-foreground text-base">
                            Complete your profile to access the platform securely.
                        </p>
                    </div>

                    {/* Form Section */}
                    <div className="px-8 pb-10">
                        {/* Success Banner */}
                        {success && (
                            <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 dark:bg-emerald-900/10 dark:border-emerald-800/30 p-4 mb-5 animate-in fade-in duration-300">
                                <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400 mt-0.5 shrink-0" />
                                <div>
                                    <p className="text-foreground text-sm font-bold">Account Created!</p>
                                    <p className="text-muted-foreground text-xs">Redirecting to your workspace...</p>
                                </div>
                            </div>
                        )}

                        {/* Error Banner */}
                        {submitError && (
                            <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/10 dark:border-red-800/30 p-4 mb-5 animate-in fade-in duration-300">
                                <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
                                <p className="text-muted-foreground text-sm font-medium">{submitError}</p>
                            </div>
                        )}

                        <form onSubmit={handleSubmit} className="space-y-5" noValidate>
                            {/* Email (locked if invite has email) */}
                            <div>
                                <Label htmlFor="email" className="text-sm font-semibold mb-1.5 block">Email Address</Label>
                                <div className="relative">
                                    <Input
                                        id="email"
                                        type="email"
                                        value={email}
                                        onChange={(e) => !inviteInfo?.email && setEmail(e.target.value)}
                                        disabled={!!inviteInfo?.email || success}
                                        placeholder="your@email.com"
                                        className={`h-12 pr-10 text-sm ${inviteInfo?.email
                                                ? "bg-muted cursor-not-allowed text-muted-foreground"
                                                : ""
                                            }`}
                                    />
                                    {inviteInfo?.email && (
                                        <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
                                            <Lock className="h-4 w-4 text-muted-foreground" />
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Full Name */}
                            <div>
                                <Label htmlFor="fullname" className="text-sm font-semibold mb-1.5 block">Full Name</Label>
                                <Input
                                    id="fullname"
                                    type="text"
                                    value={fullName}
                                    onChange={(e) => setFullName(e.target.value)}
                                    disabled={success}
                                    placeholder="e.g. John Doe"
                                    className="h-12 text-sm"
                                    required
                                />
                            </div>

                            {/* Password */}
                            <div>
                                <Label htmlFor="password" className="text-sm font-semibold mb-1.5 block">Create Password</Label>
                                <div className="relative">
                                    <Input
                                        id="password"
                                        type={showPassword ? "text" : "password"}
                                        value={password}
                                        onChange={(e) => { setPassword(e.target.value); setSubmitError(""); }}
                                        disabled={success}
                                        placeholder="Enter a strong password"
                                        className="h-12 pr-10 text-sm"
                                        autoComplete="new-password"
                                    />
                                    <button
                                        type="button"
                                        tabIndex={-1}
                                        onClick={() => setShowPassword(!showPassword)}
                                        className="absolute inset-y-0 right-0 flex items-center pr-3 text-muted-foreground hover:text-foreground transition-colors"
                                    >
                                        {showPassword ? <Eye className="h-5 w-5" /> : <EyeOff className="h-5 w-5" />}
                                    </button>
                                </div>
                            </div>

                            {/* Confirm Password */}
                            <div>
                                <Label htmlFor="confirm-password" className="text-sm font-semibold mb-1.5 block">Confirm Password</Label>
                                <div className="relative">
                                    <Input
                                        id="confirm-password"
                                        type={showConfirm ? "text" : "password"}
                                        value={confirmPassword}
                                        onChange={(e) => { setConfirmPassword(e.target.value); setSubmitError(""); }}
                                        disabled={success}
                                        placeholder="Re-enter your password"
                                        className={`h-12 pr-10 text-sm ${confirmPassword && !passwordsMatch ? "border-red-400 focus-visible:ring-red-200" : ""
                                            }`}
                                        autoComplete="new-password"
                                    />
                                    <button
                                        type="button"
                                        tabIndex={-1}
                                        onClick={() => setShowConfirm(!showConfirm)}
                                        className="absolute inset-y-0 right-0 flex items-center pr-3 text-muted-foreground hover:text-foreground transition-colors"
                                    >
                                        {showConfirm ? <Eye className="h-5 w-5" /> : <EyeOff className="h-5 w-5" />}
                                    </button>
                                </div>
                                {confirmPassword && !passwordsMatch && (
                                    <p className="text-red-500 text-xs font-medium mt-1.5 animate-in fade-in duration-200">Passwords do not match</p>
                                )}
                            </div>

                            {/* Password Requirements */}
                            <div className="bg-muted/50 p-4 rounded-lg border border-border/50">
                                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Password requirements</p>
                                <ul className="space-y-2">
                                    <PwRule passed={pwRules.length} label="At least 12 characters" />
                                    <PwRule passed={pwRules.mix} label="Mix of uppercase, lowercase, numbers & symbols" />
                                    <PwRule passed={pwRules.noEmail} label="Does not contain email address" />
                                </ul>
                            </div>

                            {/* Terms */}
                            <div className="flex items-start gap-3 pt-2">
                                <Checkbox
                                    id="terms"
                                    checked={acceptTerms}
                                    onCheckedChange={(v) => setAcceptTerms(v === true)}
                                    disabled={success}
                                    className="mt-0.5"
                                />
                                <Label htmlFor="terms" className="text-sm text-muted-foreground leading-tight cursor-pointer">
                                    I accept the{" "}
                                    <a className="font-medium text-primary hover:underline underline-offset-2" href="#">Terms of Service</a>
                                    {" "}and{" "}
                                    <a className="font-medium text-primary hover:underline underline-offset-2" href="#">Privacy Policy</a>.
                                </Label>
                            </div>

                            {/* Submit */}
                            <Button
                                type="submit"
                                className="w-full h-12 text-sm font-bold shadow-sm"
                                disabled={isSubmitting || !allPwValid || !passwordsMatch || !acceptTerms || !fullName.trim() || !email.trim() || success}
                            >
                                {isSubmitting ? (
                                    <>
                                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                        Creating account...
                                    </>
                                ) : (
                                    <>
                                        Accept Invite & Create Account
                                        <ArrowRight className="ml-2 h-4 w-4" />
                                    </>
                                )}
                            </Button>
                        </form>

                        {/* Footer */}
                        <div className="mt-8 text-center border-t border-border pt-6">
                            <p className="text-sm text-muted-foreground">
                                Already have an account?{" "}
                                <a className="font-bold text-primary hover:underline ml-1 transition-colors" href="/login">
                                    Sign In
                                </a>
                            </p>
                        </div>
                    </div>
                </div>
            </main>
        </div>
    );
}

// ─── Password rule check component ───
function PwRule({ passed, label }: { passed: boolean; label: string }) {
    return (
        <li className="flex items-center gap-2 text-sm">
            {passed ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
            ) : (
                <Circle className="h-4 w-4 text-muted-foreground/30 shrink-0" />
            )}
            <span className={passed ? "text-foreground font-medium" : "text-muted-foreground"}>
                {label}
            </span>
        </li>
    );
}
