import { useState } from 'react';
import type { FormEvent } from 'react';
import { errorMessage } from './api';
import { Icon } from './Icon';

type Props = {
  checkingAccess: boolean;
  error: string;
  onLogin: (password: string) => Promise<void>;
  onError: (message: string) => void;
};

export function LoginScreen({ checkingAccess, error, onLogin, onError }: Props) {
  const [password, setPassword] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (loggingIn || checkingAccess) return;
    setLoggingIn(true);
    onError('');
    try {
      await onLogin(password);
      setPassword('');
    } catch (cause) {
      onError(errorMessage(cause));
    } finally {
      setLoggingIn(false);
    }
  }

  return (
    <section className="login-layout">
      <div className="login-intro">
        <div className="eyebrow">GOOD CONVERSATIONS. GREAT ADVENTURES.</div>
        <h1>
          A little hello.
          <br />A whole new world.
        </h1>
        <p>
          Speak naturally. Follow the original and the translation, together in one private space.
        </p>
        <div className="language-art" aria-hidden="true">
          <span>Hello.</span>
          <span>สวัสดี</span>
          <span>你好。</span>
          <div className="art-orbit">
            <Icon name="globe" size={44} />
          </div>
        </div>
      </div>
      <form
        className="login-card"
        onSubmit={(event) => {
          submit(event).catch((cause) => onError(errorMessage(cause)));
        }}
      >
        <span className="icon-box">
          <Icon name="lock" size={25} />
        </span>
        <h2>Welcome to your workspace</h2>
        <p>Enter the shared password to start translating.</p>
        <label htmlFor="password">Workspace password</label>
        <input
          id="password"
          name="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          maxLength={1024}
          required
          autoFocus={window.matchMedia('(min-width: 681px)').matches}
          disabled={checkingAccess}
          placeholder="Enter your password…"
        />
        {error && (
          <div className="message error" role="alert">
            {error}
          </div>
        )}
        <button className="primary-button" disabled={loggingIn || checkingAccess}>
          {checkingAccess ? (
            'Checking access…'
          ) : loggingIn ? (
            'Signing in…'
          ) : (
            <>
              Enter workspace <Icon name="arrow" size={18} />
            </>
          )}
        </button>
        <div className="login-note">
          <Icon name="lock" size={13} /> Shared access. No account needed.
        </div>
      </form>
    </section>
  );
}
