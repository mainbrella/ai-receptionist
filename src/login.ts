import { createAuthClient } from './auth.ts';

const section = document.querySelector<HTMLElement>('.login-content')!;
const status = document.querySelector<HTMLElement>('#login-status')!;
const error = document.querySelector<HTMLElement>('#login-error')!;
const form = document.querySelector<HTMLFormElement>('#login-form')!;
const password = document.querySelector<HTMLInputElement>('#login-password')!;
const submit = document.querySelector<HTMLButtonElement>('#login-submit')!;
const auth = createAuthClient();

async function initialize() {
  try {
    if (await auth.readSession()) {
      window.location.replace('/');
      return;
    }
    status.textContent = 'Enter your password to continue.';
    form.hidden = false;
  } catch (caught) {
    status.textContent = '';
    error.textContent = caught instanceof Error ? caught.message : 'Could not check your sign-in. Please try again.';
    error.hidden = false;
    const retry = document.createElement('button');
    retry.className = 'quiet-button';
    retry.type = 'button';
    retry.textContent = 'Retry';
    retry.addEventListener('click', () => { error.hidden = true; status.textContent = 'Checking your session…'; void initialize(); });
    section.append(retry);
  } finally {
    section.setAttribute('aria-busy', 'false');
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  error.hidden = true;
  submit.disabled = true;
  submit.textContent = 'Signing in…';
  try {
    await auth.signIn(password.value);
    window.location.replace('/');
  } catch (caught) {
    error.textContent = caught instanceof Error ? caught.message : 'Could not sign you in. Please try again.';
    error.hidden = false;
    password.focus();
  } finally {
    submit.disabled = false;
    submit.textContent = 'Sign in';
  }
});

void initialize();
