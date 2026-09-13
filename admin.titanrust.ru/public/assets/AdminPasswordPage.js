// Maintained adapter for the checked-in Vue bundle; carry into source on rebuild.
import { d as defineComponent, j as ref, k as onMounted, b as h, a as useRoute, u as useRouter } from './index-D4siiPNB.js';
import { u as usePasskeyAuth } from './usePasskeyAuth-CyfWqoD7.js';

if (!document.querySelector('link[data-password-auth]')) {
  const css = document.createElement('link');
  css.rel = 'stylesheet'; css.href = '/assets/admin-password-auth.css';
  css.dataset.passwordAuth = ''; document.head.append(css);
}
export function passwordPage(isRegistration) {
  return defineComponent({ name: isRegistration ? 'PasswordRegistration' : 'PasswordLogin', setup() {
    const route = useRoute(), router = useRouter(), passkey = usePasskeyAuth();
    const username = ref(''), password = ref(''), confirmation = ref('');
    const busy = ref(false), checking = ref(isRegistration), error = ref(''), invite = ref(null), show = ref(false);
    const token = typeof route.query.token === 'string' ? route.query.token : '';
    async function api(path, body) {
      const response = await fetch('/api/v1/admin/auth' + path, {
        method: body ? 'POST' : 'GET', cache: 'no-store',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.message || 'Не удалось выполнить запрос.');
      return result.data;
    }
    onMounted(async () => {
      if (!isRegistration) return;
      try {
        if (!token) throw new Error('Откройте полную ссылку из приглашения. Публичной регистрации здесь нет.');
        invite.value = await api('/invite/validate?token=' + encodeURIComponent(token));
        if (!invite.value?.valid) throw new Error('Приглашение использовано или истекло. Запросите новую ссылку у владельца.');
        username.value = invite.value.username || '';
      } catch (e) { error.value = e.message; }
      finally { checking.value = false; }
    });
    function destination() {
      const next = route.query.next;
      return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') ? next : '/';
    }
    async function submit(event) {
      event.preventDefault(); if (busy.value) return;
      error.value = '';
      if (isRegistration && password.value !== confirmation.value) { error.value = 'Пароли не совпадают.'; return; }
      busy.value = true;
      try {
        const data = await api(isRegistration ? '/register' : '/login', {
          username: username.value.trim(), password: password.value,
          ...(isRegistration ? { inviteToken: token } : {})
        });
        password.value = ''; confirmation.value = '';
        if (isRegistration) {
          localStorage.removeItem('admin-token');
          await router.replace('/login?registered=1');
        } else {
          if (!data.accessToken) throw new Error('Сервер не выдал сессию.');
          localStorage.setItem('admin-token', data.accessToken);
          // Reload initializes the existing auth store from its persisted token.
          window.location.assign(destination());
        }
      } catch (e) { error.value = e.message || 'Нет соединения с сервером.'; }
      finally { busy.value = false; }
    }
    async function loginPasskey() {
      if (busy.value) return; busy.value = true; error.value = '';
      try { if (await passkey.loginWithPasskey()) window.location.assign(destination());
        else error.value = passkey.error.value || 'Вход с Passkey отменён.';
      } catch { error.value = 'Не удалось войти с Passkey.'; }
      finally { busy.value = false; }
    }
    function field(label, id, value, attrs = {}) {
      return h('div', { class: 'auth-field' }, [
        h('label', { for: id }, label),
        h('input', { id, name: id, value: value.value, required: true, disabled: busy.value,
          'aria-describedby': error.value ? 'auth-error' : undefined,
          onInput: event => { value.value = event.target.value; }, ...attrs })
      ]);
    }
    return () => h('main', { class: 'password-auth' }, [h('div', { class: 'auth-shell' }, [
      h('div', { class: 'auth-brand' }, [h('span', { class: 'auth-mark', 'aria-hidden': 'true' }, 'B'), h('span', {}, 'BEARZ'), h('small', {}, 'ПАНЕЛЬ УПРАВЛЕНИЯ')]),
      h('section', { class: 'auth-card', 'aria-labelledby': 'auth-title' }, [
        h('div', { class: 'auth-heading' }, [h('h1', { id: 'auth-title' }, isRegistration ? (invite.value?.existingAccount ? 'Настройка пароля' : 'Добро пожаловать в команду') : 'Вход в панель'),
          h('p', {}, isRegistration ? 'Создайте пароль для доступа по приглашению.' : 'Используйте логин и пароль администратора.')]),
        !isRegistration && route.query.registered ? h('div', { class: 'auth-notice', role: 'status' }, 'Пароль сохранён. Теперь войдите в аккаунт.') : null,
        error.value ? h('div', { class: 'auth-error', id: 'auth-error', role: 'alert' }, error.value) : null,
        checking.value ? h('p', { role: 'status' }, 'Проверяем приглашение…') : null,
        isRegistration && invite.value?.valid ? h('div', { class: 'auth-invite' }, [
          h('span', {}, 'ВАШЕ ПРИГЛАШЕНИЕ'), h('strong', {}, invite.value.targetRole),
          h('small', {}, 'Действует до ' + new Date(invite.value.expiresAt).toLocaleString('ru-RU'))]) : null,
        !isRegistration || invite.value?.valid ? h('form', { onSubmit: submit, 'aria-busy': busy.value }, [
          field('Логин', 'username', username, { type: 'text', autocomplete: 'username', spellcheck: false, autocapitalize: 'none',
            readOnly: Boolean(isRegistration && invite.value?.username), maxlength: 64, placeholder: 'Ваш логин' }),
          field('Пароль', 'password', password, { type: show.value ? 'text' : 'password', autocomplete: isRegistration ? 'new-password' : 'current-password',
            ...(isRegistration ? { minlength: 15, maxlength: 256 } : {}), placeholder: isRegistration ? 'Не менее 15 символов' : 'Ваш пароль' }),
          isRegistration ? field('Повторите пароль', 'password-confirmation', confirmation, { type: show.value ? 'text' : 'password', autocomplete: 'new-password', maxlength: 256 }) : null,
          h('button', { type: 'button', class: 'auth-reveal', 'aria-pressed': show.value, onClick: () => { show.value = !show.value; } }, show.value ? 'Скрыть пароль' : 'Показать пароль'),
          isRegistration ? h('p', { class: 'auth-hint' }, '15–128 символов. Подойдёт длинная фраза. USB-ключ не нужен.') : null,
          h('button', { class: 'auth-submit', type: 'submit', disabled: busy.value }, busy.value ? 'Подождите…' : isRegistration ? 'Сохранить пароль' : 'Войти'),
        ]) : null,
        !isRegistration ? h('p', { class: 'auth-hint' }, 'Нет доступа или забыли пароль? Запросите приглашение у владельца.') : h('a', { href: '/login', class: 'auth-footer' }, 'Уже есть аккаунт? Войти'),
        !isRegistration && passkey.isSupported ? h('details', { class: 'auth-alternative' }, [h('summary', {}, 'Другой способ входа'),
          h('p', { class: 'auth-hint' }, 'Только если вы уже регистрировали Passkey.'),
          h('button', { type: 'button', class: 'auth-secondary', disabled: busy.value, onClick: loginPasskey }, 'Войти с существующим Passkey')]) : null
      ]), h('p', { class: 'auth-bottom' }, 'Доступ только для приглашённых администраторов')
    ])]);
  } });
}
