<template>
  <div class="loginPopup">
    <div v-if="screen == 'login'">
      <h2>
        <span class="ui zh">登录星花札记</span><span class="ui en">Log in</span>
      </h2>

      <div class="inputHelperText">
        <span class="ui zh">用户名或邮箱</span
        ><span class="ui en">Username or email</span>
      </div>
      <input
        type="text"
        v-model.trim="loginIdentifier"
        autocomplete="username"
        @keypress="(e) => e.key == 'Enter' && canLogin && login()"
      />

      <div class="inputHelperText">
        <span class="ui zh">密码</span><span class="ui en">Password</span>
        <span class="help" @click="forgotPassword">
          <span class="ui zh">忘记密码</span
          ><span class="ui en">Forgot password</span>
        </span>
      </div>
      <input
        type="password"
        v-model="loginPassword"
        autocomplete="current-password"
        @keypress="(e) => e.key == 'Enter' && canLogin && login()"
      />

      <p class="altLoginOption" @click="screen = 'register'">
        <span class="ui zh">第一次来？注册账号</span
        ><span class="ui en">New here? Create an account</span>
      </p>

      <button class="okBtn" :disabled="!canLogin || busy" @click="login()">
        <span class="ui zh">{{ busy ? '正在登录…' : '登录 →' }}</span>
        <span class="ui en">{{ busy ? 'Logging in…' : 'Log in →' }}</span>
      </button>
    </div>

    <div v-else-if="screen == 'register'">
      <h2>
        <span class="ui zh">注册账号</span
        ><span class="ui en">Create an account</span>
      </h2>

      <div class="inputHelperText">
        <span class="ui zh">用户名</span><span class="ui en">Username</span>
      </div>
      <input type="text" v-model.trim="regName" autocomplete="username" />

      <div class="inputHelperText">
        <span class="ui zh">邮箱</span><span class="ui en">Email</span>
      </div>
      <input type="email" v-model.trim="regEmail" autocomplete="email" />
      <div class="inputHelperText privacy-note">
        <span class="ui zh">邮箱可作为登录标识，不会公开展示。</span>
        <span class="ui en"
          >Your email can be used to log in and is never displayed
          publicly.</span
        >
      </div>

      <div class="inputHelperText">
        <span class="ui zh">密码（至少 8 个字符）</span
        ><span class="ui en">Password (8 characters minimum)</span>
      </div>
      <input
        type="password"
        v-model="regPassword"
        autocomplete="new-password"
      />

      <div class="inputHelperText">
        <span class="ui zh">确认密码</span
        ><span class="ui en">Confirm password</span>
      </div>
      <input
        type="password"
        v-model="regPasswordConfirm"
        autocomplete="new-password"
        @keypress="(e) => e.key == 'Enter' && register()"
      />

      <p class="altLoginOption" @click="screen = 'login'">
        <span class="ui zh">已有账号？返回登录</span
        ><span class="ui en">Already registered? Log in</span>
      </p>

      <button class="okBtn" :disabled="busy" @click="register()">
        <span class="ui zh">{{ busy ? '正在注册…' : '注册并登录 →' }}</span>
        <span class="ui en">{{
          busy ? 'Registering…' : 'Register and log in →'
        }}</span>
      </button>
    </div>

    <div v-else>
      <h2>
        <span class="ui zh">使用恢复密钥找回账号</span
        ><span class="ui en">Recover your account</span>
      </h2>

      <div class="inputHelperText">
        <span class="ui zh">用户名或邮箱</span
        ><span class="ui en">Username or email</span>
      </div>
      <input
        v-model.trim="recoverIdentifier"
        type="text"
        autocomplete="username"
      />

      <div class="inputHelperText">
        <span class="ui zh">恢复密钥</span
        ><span class="ui en">Recovery key</span>
      </div>
      <input
        v-model.trim="recoverKey"
        type="text"
        autocomplete="off"
        autocapitalize="characters"
        spellcheck="false"
      />

      <div class="inputHelperText">
        <span class="ui zh">新密码（至少 8 个字符）</span
        ><span class="ui en">New password (8 characters minimum)</span>
      </div>
      <input
        v-model="recoverPassword"
        type="password"
        autocomplete="new-password"
      />

      <div class="inputHelperText">
        <span class="ui zh">确认新密码</span
        ><span class="ui en">Confirm new password</span>
      </div>
      <input
        v-model="recoverPasswordConfirm"
        type="password"
        autocomplete="new-password"
        @keypress="(event) => event.key === 'Enter' && recover()"
      />

      <p class="altLoginOption" @click="screen = 'login'">
        <span class="ui zh">返回登录</span
        ><span class="ui en">Back to login</span>
      </p>

      <button class="okBtn" :disabled="busy" @click="recover()">
        <span class="ui zh">{{ busy ? '正在恢复…' : '恢复账号 →' }}</span>
        <span class="ui en">{{ busy ? 'Recovering…' : 'Recover →' }}</span>
      </button>
    </div>
  </div>
</template>

<script lang="ts">
import FloatMsgs from '../FloatMsgs'
import Popups from './index'
import XHR from '../../net/xhr'
import {
  applyAuthenticatedSession,
  continueAfterAuthentication,
  type AuthenticatedSessionResponse,
} from '../../features/auth/auth-actions'
import {
  validateEmail,
  validatePassword,
  validateUsername,
} from '../../../shared/validation'

export default {
  data: () => ({
    screen: 'login',
    busy: false,
    loginIdentifier: '',
    loginPassword: '',
    regName: '',
    regEmail: '',
    regPassword: '',
    regPasswordConfirm: '',
    recoverIdentifier: '',
    recoverKey: '',
    recoverPassword: '',
    recoverPasswordConfirm: '',
  }),

  computed: {
    canLogin() {
      return this.loginIdentifier.length > 0 && this.loginPassword.length > 0
    },
  },

  methods: {
    finish(response: AuthenticatedSessionResponse, message: string) {
      applyAuthenticatedSession(response)
      this.$emit('close')
      FloatMsgs.show({ type: 'success', msg: message })
      continueAfterAuthentication()
    },

    finishRegistration(
      response: AuthenticatedSessionResponse & { recoveryKey: string },
    ) {
      applyAuthenticatedSession(response)
      this.$emit('close')
      Popups.show('recoveryKeyPopup', {
        recoveryKey: response.recoveryKey,
        reason: 'registration',
      })
      continueAfterAuthentication()
    },

    login() {
      if (!this.canLogin || this.busy) return
      this.busy = true
      XHR.post<AuthenticatedSessionResponse>(
        'user/login',
        {
          identifier: this.loginIdentifier,
          password: this.loginPassword,
        },
        { suppressUnauthorizedHandler: true },
      )
        .then((r) => {
          if (r.code == 1) {
            this.finish(
              r.data,
              '<span class="ui zh">登录成功</span><span class="ui en">Logged in</span>',
            )
          }
        })
        .finally(() => {
          this.busy = false
        })
    },

    register() {
      if (this.busy) return
      const validationError =
        validateUsername(this.regName) ||
        validateEmail(this.regEmail) ||
        validatePassword(this.regPassword) ||
        (this.regPassword !== this.regPasswordConfirm
          ? '两次输入的密码不一致'
          : null)
      if (validationError) {
        FloatMsgs.show({ type: 'warn', msg: validationError })
        return
      }
      this.busy = true
      XHR.post<AuthenticatedSessionResponse & { recoveryKey: string }>(
        'user/register',
        {
          name: this.regName,
          email: this.regEmail,
          password: this.regPassword,
        },
      )
        .then((r) => {
          if (r.code == 1) {
            this.finishRegistration(r.data)
          }
        })
        .finally(() => {
          this.busy = false
        })
    },

    forgotPassword() {
      this.recoverIdentifier = this.loginIdentifier
      this.screen = 'recover'
    },

    recover() {
      if (this.busy) return
      const validationError =
        (!this.recoverIdentifier || !this.recoverKey
          ? '请填写账号信息和恢复密钥'
          : null) ||
        validatePassword(this.recoverPassword) ||
        (this.recoverPassword !== this.recoverPasswordConfirm
          ? '两次输入的密码不一致'
          : null)
      if (validationError) {
        FloatMsgs.show({ type: 'warn', msg: validationError })
        return
      }
      this.busy = true
      XHR.post<{ recoveryKey: string }>('user/recover', {
        identifier: this.recoverIdentifier,
        recoveryKey: this.recoverKey,
        password: this.recoverPassword,
      })
        .then((response) => {
          if (response.code !== 1) return
          this.$emit('close')
          Popups.show('recoveryKeyPopup', {
            recoveryKey: response.data.recoveryKey,
            reason: 'recovery',
          })
        })
        .finally(() => {
          this.busy = false
        })
    },
  },
}
</script>

<style scoped>
.privacy-note {
  margin-top: -0.55rem;
  margin-bottom: 1rem;
  line-height: 1.45;
  opacity: 0.78;
}
</style>
