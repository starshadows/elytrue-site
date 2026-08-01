<template>
    <div class="loginPopup">
        <div v-if="screen == 'login'">
            <h2><span class="ui zh">登录星花札记</span><span class="ui en">Log in</span></h2>

            <div class="inputHelperText">
                <span class="ui zh">用户名或邮箱</span><span class="ui en">Username or email</span>
            </div>
            <input
                type="text"
                v-model.trim="loginIdentifier"
                autocomplete="username"
                @keypress="e => e.key == 'Enter' && canLogin && login()"
            >

            <div class="inputHelperText">
                <span class="ui zh">密码</span><span class="ui en">Password</span>
                <span class="help" @click="forgotPassword">
                    <span class="ui zh">忘记密码</span><span class="ui en">Forgot password</span>
                </span>
            </div>
            <input
                type="password"
                v-model="loginPassword"
                autocomplete="current-password"
                @keypress="e => e.key == 'Enter' && canLogin && login()"
            >

            <p class="altLoginOption" @click="screen = 'register'">
                <span class="ui zh">第一次来？注册账号</span><span class="ui en">New here? Create an account</span>
            </p>

            <button class="okBtn" :disabled="!canLogin || busy" @click="login()">
                <span class="ui zh">{{ busy ? '正在登录…' : '登录 →' }}</span>
                <span class="ui en">{{ busy ? 'Logging in…' : 'Log in →' }}</span>
            </button>
        </div>

        <div v-else>
            <h2><span class="ui zh">注册账号</span><span class="ui en">Create an account</span></h2>

            <div class="inputHelperText"><span class="ui zh">用户名</span><span class="ui en">Username</span></div>
            <input type="text" v-model.trim="regName" autocomplete="username">

            <div class="inputHelperText"><span class="ui zh">邮箱</span><span class="ui en">Email</span></div>
            <input type="email" v-model.trim="regEmail" autocomplete="email">
            <div class="inputHelperText privacy-note">
                <span class="ui zh">请填写本人长期可用邮箱。邮箱仅用于登录、密码找回和账号安全通知，不会公开展示；填写错误将无法找回密码。</span>
                <span class="ui en">Use a long-term email address. It is used only for login, password recovery and account security, and is never displayed publicly.</span>
            </div>

            <div class="inputHelperText"><span class="ui zh">密码（至少 8 个字符）</span><span class="ui en">Password (8 characters minimum)</span></div>
            <input type="password" v-model="regPassword" autocomplete="new-password">

            <div class="inputHelperText"><span class="ui zh">确认密码</span><span class="ui en">Confirm password</span></div>
            <input
                type="password"
                v-model="regPasswordConfirm"
                autocomplete="new-password"
                @keypress="e => e.key == 'Enter' && canRegister && register()"
            >

            <p class="altLoginOption" @click="screen = 'login'">
                <span class="ui zh">已有账号？返回登录</span><span class="ui en">Already registered? Log in</span>
            </p>

            <button class="okBtn" :disabled="!canRegister || busy" @click="register()">
                <span class="ui zh">{{ busy ? '正在注册…' : '注册并登录 →' }}</span>
                <span class="ui en">{{ busy ? 'Registering…' : 'Register and log in →' }}</span>
            </button>
        </div>
    </div>
</template>

<script lang="ts">
// @ts-nocheck

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
    }),

    computed: {
        canLogin() {
            return this.loginIdentifier.length > 0 && this.loginPassword.length > 0
        },
        canRegister() {
            return this.regName.length >= 2
                && this.regEmail.includes('@')
                && this.regPassword.length >= 8
                && this.regPassword === this.regPasswordConfirm
        },
    },

    methods: {
        finish(message) {
            XHR.token = 'session'
            this.$emit('close')
            loadUserInfo()
            FloatMsgs.show({ type: 'success', msg: message })
        },

        login() {
            if (!this.canLogin || this.busy) return
            this.busy = true
            XHR.post('user/login', {
                identifier: this.loginIdentifier,
                password: this.loginPassword,
            }).then(r => {
                if (r.code == 1) {
                    this.finish('<span class="ui zh">登录成功</span><span class="ui en">Logged in</span>')
                }
            }).finally(() => {
                this.busy = false
            })
        },

        register() {
            if (!this.canRegister || this.busy) return
            this.busy = true
            XHR.post('user/register', {
                name: this.regName,
                email: this.regEmail,
                password: this.regPassword,
            }).then(r => {
                if (r.code == 1) {
                    this.finish('<span class="ui zh">注册成功，欢迎来到星花札记</span><span class="ui en">Registration successful</span>')
                }
            }).finally(() => {
                this.busy = false
            })
        },

        forgotPassword() {
            Popup.show('promptInputPopup', {
                title: '<span class="ui zh">找回密码</span><span class="ui en">Reset password</span>',
                subtitle: `
                    <span class="ui zh">输入注册时使用的用户名或邮箱。无论账号是否存在，系统都会返回相同结果。</span>
                    <span class="ui en">Enter your username or registered email.</span>
                `,
                text: this.loginIdentifier,
                action(identifier) {
                    this.disabled = true
                    XHR.post('user/resetpassword', { identifier }).then(r => {
                        if (r.code == 1) {
                            this.$emit('close')
                            FloatMsgs.show({
                                type: 'success',
                                persist: true,
                                msg: '<span class="ui zh">如果账号存在，重置邮件会发送到注册邮箱，请留意收件箱。</span><span class="ui en">If the account exists, a reset email will be sent.</span>',
                            })
                        }
                    }).finally(() => {
                        this.disabled = false
                    })
                },
            })
        },
    },
}
</script>

<style scoped>
.privacy-note {
    margin-top: -0.65rem;
    margin-bottom: 1rem;
    line-height: 1.45;
    opacity: 0.78;
}
</style>
