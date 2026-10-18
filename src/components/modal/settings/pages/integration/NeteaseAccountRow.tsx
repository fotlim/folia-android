import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Row, Status } from '../../kit';
import { O } from './options';
import { neteaseApi } from '../../../../../services/onlineMusic/netease/netease';
import { getRuntimeServerEndpoint } from '../../../../../services/runtimeConfig';
import { isAndroidShell } from '../../../../../services/mobileShell/nativeBridge';

// src/components/modal/settings/pages/integration/NeteaseAccountRow.tsx
// 网易云的账号密码登录。扫码要开官方 App，账号密码在只有手机时就顺手得多：这里是两格输入加一个按钮，
// 登录本身仍然由后端完成（`/login/cellphone` 要签名，浏览器直连做不了），所以只有在配置了接口地址、
// 或者桌面端自带的本地后端时才显示。登录成功后整页重载，账号状态和其他页面一起刷新。

const phoneLooksValid = (value: string): boolean => /^\d{6,15}$/.test(value.trim());

const NeteaseAccountRow: React.FC = () => {
    const { t } = useTranslation();
    const [phone, setPhone] = useState('');
    const [password, setPassword] = useState('');
    const [captcha, setCaptcha] = useState('');
    const [captchaSent, setCaptchaSent] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState(false);

    // 桌面端自带本地后端，手机端没有后端时走原生直连 + weapi 加密，所以两种环境都能登录；
    // 这一行保留成常量是为了让「没有后端」的分支以后接回来时不用再改结构。
    const hasBackend = true;

    const codeLooksValid = (value: string): boolean => /^\d{4,6}$/.test(value.trim());

    const sendCode = async () => {
        if (!hasBackend || !phoneLooksValid(phone)) {
            setError(t('options.neteaseAccountInvalid'));
            return;
        }
        setError(null);
        try {
            const result = await neteaseApi.sendCaptcha(phone.trim());
            const code = (result as { code?: number } | null)?.code;
            if (typeof code === 'number' && code !== 200) {
                setError((result as { message?: string; msg?: string }).message
                    ?? (result as { msg?: string }).msg ?? `code ${code}`);
                return;
            }
            setCaptchaSent(true);
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure));
        }
    };

    const submit = async () => {
        if (!hasBackend) return;
        const byCode = captchaSent;
        if (!phoneLooksValid(phone) || (byCode ? !codeLooksValid(captcha) : password.length < 4)) {
            setError(t('options.neteaseAccountInvalid'));
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const result = byCode
                ? await neteaseApi.loginCellphoneCaptcha(phone.trim(), captcha.trim())
                : await neteaseApi.loginCellphone(phone.trim(), password);
            const code = (result as { code?: number } | null)?.code;
            if (typeof code === 'number' && code !== 200) {
                const message = (result as { message?: string; msg?: string }).message
                    ?? (result as { msg?: string }).msg
                    ?? `code ${code}`;
                setError(message);
                return;
            }
            setDone(true);
            // 账号状态散在很多 store 里，重载是最省事也最不会漏的一步（和原生改地址后的做法一致）。
            window.setTimeout(() => window.location.reload(), 600);
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <Row option={O.neteaseAccount} hint={t(hasBackend ? 'options.neteaseAccountDesc' : 'options.neteaseAccountNeedsBackend')}>
                {done ? <Status tone="ok">{t('options.neteaseAccountDone')}</Status> : null}
                <Button onClick={() => void sendCode()} disabled={busy || !hasBackend}>
                    {t('options.neteaseAccountSendCode')}
                </Button>
                <Button onClick={() => void submit()} disabled={busy || !hasBackend}>
                    {busy ? t('options.neteaseAccountBusy') : t('options.neteaseAccountSignIn')}
                </Button>
            </Row>
            <Row sub>
                <div className="flex w-full flex-wrap items-center gap-2">
                    <input
                        value={phone}
                        onChange={event => setPhone(event.target.value)}
                        inputMode="numeric"
                        autoComplete="tel"
                        placeholder={t('options.neteaseAccountPhone')}
                        aria-label={t('options.neteaseAccountPhone')}
                        className="st-card min-w-0 flex-[1_1_140px] bg-[var(--st-fill)] px-3 py-2 text-sm text-[color:var(--st-t1)] outline-none placeholder:text-[color:var(--st-t3)] focus:shadow-[inset_0_0_0_1px_var(--st-accent)]"
                    />
                    <input
                        value={password}
                        onChange={event => setPassword(event.target.value)}
                        type="password"
                        autoComplete="current-password"
                        placeholder={t('options.neteaseAccountPassword')}
                        aria-label={t('options.neteaseAccountPassword')}
                        className="st-card min-w-0 flex-[1_1_140px] bg-[var(--st-fill)] px-3 py-2 text-sm text-[color:var(--st-t1)] outline-none placeholder:text-[color:var(--st-t3)] focus:shadow-[inset_0_0_0_1px_var(--st-accent)]"
                    />
                    <input
                        value={captcha}
                        onChange={event => setCaptcha(event.target.value)}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        placeholder={t('options.neteaseAccountCode')}
                        aria-label={t('options.neteaseAccountCode')}
                        className="st-card min-w-0 flex-[0_1_120px] bg-[var(--st-fill)] px-3 py-2 text-sm text-[color:var(--st-t1)] outline-none placeholder:text-[color:var(--st-t3)] focus:shadow-[inset_0_0_0_1px_var(--st-accent)]"
                    />
                </div>
            </Row>
            {error ? (
                <Row sub>
                    <Status tone="error">{error}</Status>
                </Row>
            ) : null}
        </>
    );
};

export default NeteaseAccountRow;
