<template>
  <div>
    <h2>
      <span class="ui zh">设置新密码</span
      ><span class="ui en">Set new password</span>
    </h2>

    <div class="inputHelperText">
      <span class="ui zh">新密码</span
      ><span class="ui en">Enter new password</span>
    </div>
    <input
      :type="showPassword ? 'text' : 'password'"
      v-model="password"
      autocomplete="new-password"
    />

    <div class="inputHelperText">
      <span class="ui zh">确认密码</span
      ><span class="ui en">Confirm password</span>
    </div>
    <input
      :type="showPassword ? 'text' : 'password'"
      v-model="passwordConfirm"
    />

    <label class="setting-switch" style="margin: 0.25rem 0">
      <span class="ui zh">显示密码</span
      ><span class="ui en">Show password</span>
      <input type="checkbox" v-model="showPassword" />
    </label>

    <button
      class="okBtn"
      :disabled="password.length < 8 || password != passwordConfirm"
      @click="submit()"
    >
      <span class="ui zh">确定 ✔</span><span class="ui en">OK ✔</span>
    </button>
  </div>
</template>

<script lang="ts">
import FloatMsgs from '../FloatMsgs'
import XHR from '../../net/xhr'
import { refreshAuth } from '../../features/auth/auth-actions'
import { authStore } from '../../features/auth/auth-store'

export default {
  data: () => ({
    password: '',
    passwordConfirm: '',
    showPassword: false,
  }),

  methods: {
    submit() {
      XHR.put('user/update', { password: this.password }).then((r) => {
        if (r.code == 1) {
          this.$emit('close')
          XHR.token = ''
          XHR.csrfToken = ''
          authStore.clear()
          void refreshAuth()
          FloatMsgs.show({
            type: 'success',
            msg: '<span class="ui zh">密码修改成功，请重新登录</span><span class="ui en">Password updated. Please log in again.</span>',
          })
        }
      })
    },
  },
}
</script>
