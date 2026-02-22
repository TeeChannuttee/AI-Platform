"use client";

import React, { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck, Mail, Eye, EyeOff, LogIn, Lock, Gauge, AlertCircle, CheckCircle2, Headset } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { useAuth, ApiRequestError } from "@/lib/auth-context";
import { authApi } from "@/lib/api";

export default function LoginPage() {
    const router = useRouter();
    const { login, isAuthenticated, isLoading: authLoading } = useAuth();

    // Form state
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [remember, setRemember] = useState(false);

    // UI state
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [shaking, setShaking] = useState(false);
    const [systemStatus, setSystemStatus] = useState<"checking" | "online" | "offline">("checking");

    // Banner state
    const [banner, setBanner] = useState<{
        type: "lockout" | "rateLimit" | "error" | "success";
        message?: string;
        seconds?: number;
    } | null>(null);

    // Lockout timer
    const [lockoutRemaining, setLockoutRemaining] = useState(0);
    const lockoutRef = useRef<NodeJS.Timeout | null>(null);

    // Validation errors
    const [emailError, setEmailError] = useState("");
    const [passwordError, setPasswordError] = useState("");

    const emailRef = useRef<HTMLInputElement>(null);
    const passwordRef = useRef<HTMLInputElement>(null);

    // ─── Redirect if already logged in ───
    useEffect(() => {
        if (!authLoading && isAuthenticated) {
            router.push("/dashboard");
        }
    }, [isAuthenticated, authLoading, router]);

    // ─── Restore remembered email ───
    useEffect(() => {
        const saved = localStorage.getItem("remembered_email");
        if (saved) {
            setEmail(saved);
            setRemember(true);
            passwordRef.current?.focus();
        } else {
            emailRef.current?.focus();
        }
    }, []);

    // ─── Check system status ───
    useEffect(() => {
        authApi.healthz()
            .then(() => setSystemStatus("online"))
            .catch(() => setSystemStatus("offline"));
    }, []);

    // ─── Lockout countdown ───
    useEffect(() => {
        if (lockoutRemaining > 0) {
            lockoutRef.current = setInterval(() => {
                setLockoutRemaining((prev) => {
                    if (prev <= 1) {
                        clearInterval(lockoutRef.current!);
                        setBanner(null);
                        return 0;
                    }
                    return prev - 1;
                });
            }, 1000);
            return () => {
                if (lockoutRef.current) clearInterval(lockoutRef.current);
            };
        }
    }, [lockoutRemaining]);

    // ─── Format seconds to MM:SS ───
    function formatTime(s: number): string {
        const m = Math.floor(s / 60);
        const sec = s % 60;
        return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    }

    // ─── Validation ───
    function validate(): boolean {
        let valid = true;
        setEmailError("");
        setPasswordError("");

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!email.trim() || !emailRegex.test(email.trim())) {
            setEmailError("Please enter a valid email address");
            valid = false;
        }
        if (!password || password.length < 6) {
            setPasswordError("Password must be at least 6 characters");
            valid = false;
        }

        if (!valid) {
            triggerShake();
        }
        return valid;
    }

    function triggerShake() {
        setShaking(true);
        setTimeout(() => setShaking(false), 500);
    }

    // ─── Submit ───
    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (isSubmitting || lockoutRemaining > 0) return;

        setBanner(null);
        if (!validate()) return;

        setIsSubmitting(true);

        try {
            await login(email.trim(), password, remember);

            // Success!
            setBanner({ type: "success" });
            setTimeout(() => {
                router.push("/dashboard");
            }, 800);
        } catch (err) {
            if (err instanceof ApiRequestError) {
                switch (err.status) {
                    case 401:
                        setBanner({ type: "error", message: err.data.detail || "Invalid email or password" });
                        setPassword("");
                        passwordRef.current?.focus();
                        triggerShake();
                        break;

                    case 423: {
                        // Extract seconds from message
                        const match = (err.data.detail || "").match(/(\d+)\s*seconds/i);
                        const seconds = match ? parseInt(match[1]) : 300;
                        setBanner({ type: "lockout", seconds });
                        setLockoutRemaining(seconds);
                        break;
                    }

                    case 429:
                        setBanner({ type: "rateLimit" });
                        break;

                    default:
                        setBanner({ type: "error", message: err.data.detail || `Login failed (${err.status})` });
                }
            } else {
                setBanner({ type: "error", message: "Cannot connect to server. Please check your connection." });
            }
        } finally {
            setIsSubmitting(false);
        }
    }

    const isLocked = lockoutRemaining > 0;

    // ─── Don't render until auth check completes ───
    if (authLoading) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-background">
                <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
            </div>
        );
    }

    return (
        <div className="min-h-screen flex items-center justify-center p-4 bg-background">
            <main className="w-full max-w-[480px] flex flex-col items-center">
                {/* Logo */}
                <div className="mb-8 flex flex-col items-center gap-2">
                    <div className="h-12 w-12 rounded-xl bg-primary flex items-center justify-center shadow-lg shadow-primary/30">
                        <ShieldCheck className="h-7 w-7 text-primary-foreground" />
                    </div>
                    <h1 className="text-foreground text-2xl font-bold tracking-tight">Secure Portal</h1>
                </div>

                {/* Card */}
                <Card className={`w-full overflow-hidden relative shadow-[0_8px_30px_rgb(0,0,0,0.04)] ${shaking ? "animate-shake" : ""}`}>
                    {/* Top gradient line */}
                    <div className="absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-primary/60 via-primary to-primary/60" />

                    <CardContent className="p-8 flex flex-col gap-6">
                        {/* Header */}
                        <div className="text-center">
                            <h2 className="text-foreground text-xl font-bold leading-tight tracking-[-0.015em]">Welcome Back</h2>
                            <p className="text-muted-foreground text-sm font-medium mt-1">
                                Enter your credentials to access the workspace
                            </p>
                        </div>

                        {/* ─── Banners ─── */}
                        {banner?.type === "lockout" && (
                            <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/10 dark:border-red-800/30 p-4 animate-in fade-in duration-300">
                                <Lock className="h-5 w-5 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
                                <div className="flex flex-col gap-1">
                                    <p className="text-foreground text-sm font-bold">Security Lockout</p>
                                    <p className="text-muted-foreground text-xs leading-relaxed">
                                        Account locked due to multiple failed attempts.
                                        <br />
                                        Please try again in{" "}
                                        <span className="font-bold tabular-nums text-red-700 dark:text-red-300">
                                            {formatTime(lockoutRemaining)}
                                        </span>
                                    </p>
                                </div>
                            </div>
                        )}

                        {banner?.type === "rateLimit" && (
                            <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-900/10 dark:border-amber-800/30 p-4 animate-in fade-in duration-300">
                                <Gauge className="h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                                <div className="flex flex-col gap-1">
                                    <p className="text-foreground text-sm font-bold">Too Many Attempts</p>
                                    <p className="text-muted-foreground text-xs leading-relaxed">
                                        Please wait a moment before trying again.
                                    </p>
                                </div>
                            </div>
                        )}

                        {banner?.type === "error" && (
                            <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/10 dark:border-red-800/30 p-4 animate-in fade-in duration-300">
                                <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
                                <p className="text-muted-foreground text-sm font-medium">{banner.message}</p>
                            </div>
                        )}

                        {banner?.type === "success" && (
                            <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 dark:bg-emerald-900/10 dark:border-emerald-800/30 p-4 animate-in fade-in duration-300">
                                <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400 mt-0.5 shrink-0" />
                                <div className="flex flex-col gap-1">
                                    <p className="text-foreground text-sm font-bold">Login Successful</p>
                                    <p className="text-muted-foreground text-xs">Redirecting to your workspace...</p>
                                </div>
                            </div>
                        )}

                        {/* ─── Form ─── */}
                        <form onSubmit={handleSubmit} className="flex flex-col gap-5" noValidate>
                            {/* Email */}
                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor="email" className="text-sm font-semibold">Work Email</Label>
                                <div className="relative">
                                    <Input
                                        ref={emailRef}
                                        id="email"
                                        type="email"
                                        placeholder="name@company.com"
                                        value={email}
                                        onChange={(e) => { setEmail(e.target.value); setEmailError(""); setBanner(null); }}
                                        disabled={isLocked || banner?.type === "success"}
                                        className={`h-12 px-4 pr-10 text-base ${emailError ? "border-red-400 focus-visible:ring-red-200" : ""}`}
                                        autoComplete="email"
                                    />
                                    <Mail className="absolute right-3 top-3.5 h-5 w-5 text-muted-foreground pointer-events-none" />
                                </div>
                                {emailError && <p className="text-red-500 text-xs font-medium animate-in fade-in duration-200">{emailError}</p>}
                            </div>

                            {/* Password */}
                            <div className="flex flex-col gap-1.5">
                                <div className="flex justify-between items-center">
                                    <Label htmlFor="password" className="text-sm font-semibold">Password</Label>
                                    <a className="text-primary text-xs font-semibold hover:underline underline-offset-2" href="#">
                                        Forgot password?
                                    </a>
                                </div>
                                <div className="relative">
                                    <Input
                                        ref={passwordRef}
                                        id="password"
                                        type={showPassword ? "text" : "password"}
                                        placeholder="••••••••"
                                        value={password}
                                        onChange={(e) => { setPassword(e.target.value); setPasswordError(""); setBanner(null); }}
                                        disabled={isLocked || banner?.type === "success"}
                                        className={`h-12 px-4 pr-12 text-base ${passwordError ? "border-red-400 focus-visible:ring-red-200" : ""}`}
                                        autoComplete="current-password"
                                    />
                                    <button
                                        type="button"
                                        tabIndex={-1}
                                        onClick={() => setShowPassword(!showPassword)}
                                        className="absolute right-0 top-0 h-12 w-12 flex items-center justify-center text-muted-foreground hover:text-primary transition-colors"
                                        disabled={isLocked}
                                    >
                                        {showPassword ? <Eye className="h-5 w-5" /> : <EyeOff className="h-5 w-5" />}
                                    </button>
                                </div>
                                {passwordError && <p className="text-red-500 text-xs font-medium animate-in fade-in duration-200">{passwordError}</p>}
                            </div>

                            {/* Remember Me */}
                            <div className="flex items-center gap-3">
                                <Checkbox
                                    id="remember"
                                    checked={remember}
                                    onCheckedChange={(v) => setRemember(v === true)}
                                    disabled={isLocked || banner?.type === "success"}
                                />
                                <Label htmlFor="remember" className="text-sm text-muted-foreground font-medium cursor-pointer select-none">
                                    Remember this device
                                </Label>
                            </div>

                            {/* Submit */}
                            <Button
                                type="submit"
                                className="h-12 text-base font-bold tracking-[0.015em] shadow-md shadow-primary/10 hover:shadow-lg hover:shadow-primary/20 mt-2"
                                disabled={isSubmitting || isLocked || banner?.type === "success"}
                            >
                                {isSubmitting ? (
                                    <>
                                        <div className="animate-spin h-5 w-5 border-2 border-white/30 border-t-white rounded-full mr-2" />
                                        Authenticating...
                                    </>
                                ) : (
                                    <>
                                        Secure Login
                                        <LogIn className="ml-2 h-5 w-5" />
                                    </>
                                )}
                            </Button>
                        </form>

                        {/* Divider */}
                        <div className="relative flex py-1 items-center">
                            <div className="flex-grow border-t border-border" />
                            <span className="flex-shrink-0 mx-4 text-muted-foreground text-xs font-medium uppercase tracking-wider">Or</span>
                            <div className="flex-grow border-t border-border" />
                        </div>

                        {/* Register */}
                        <div className="flex justify-center">
                            <p className="text-sm text-muted-foreground font-medium">
                                Don&apos;t have an account?{" "}
                                <a className="text-primary font-bold hover:underline decoration-2 underline-offset-2 ml-1" href="/register">
                                    Register Access
                                </a>
                            </p>
                        </div>
                    </CardContent>

                    {/* Bottom bar */}
                    <CardFooter className="bg-muted/50 border-t border-border px-8 py-4 flex justify-between items-center">
                        <button className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-primary transition-colors">
                            <Headset className="h-4 w-4" />
                            Contact Support
                        </button>
                        <div className="flex gap-1.5 items-center">
                            <span
                                className={`h-1.5 w-1.5 rounded-full animate-pulse-dot ${systemStatus === "online"
                                        ? "bg-emerald-500"
                                        : systemStatus === "offline"
                                            ? "bg-red-500"
                                            : "bg-amber-500"
                                    }`}
                            />
                            <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest leading-none">
                                {systemStatus === "online"
                                    ? "System Operational"
                                    : systemStatus === "offline"
                                        ? "System Offline"
                                        : "Connecting..."}
                            </span>
                        </div>
                    </CardFooter>
                </Card>

                {/* Footer */}
                <p className="mt-8 text-xs text-muted-foreground text-center max-w-xs leading-relaxed">
                    Protected by Enterprise Guard™. By logging in, you agree to our{" "}
                    <a className="hover:text-primary underline" href="#">Terms of Service</a> and{" "}
                    <a className="hover:text-primary underline" href="#">Privacy Policy</a>.
                </p>
            </main>
        </div>
    );
}
