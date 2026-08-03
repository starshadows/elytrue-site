<template>
  <div class="userHome" @scroll="handleScroll">
    <div class="userinfo">
      <img :src="convertAvatarPath(user.avatar)" @click="viewUserAvatar" />
      <div>
        <div>{{ user.name }}</div>
        <div>
          <span>UID: {{ user.id }}&nbsp;&nbsp;</span>
          <span>
            <span class="ui zh">注册时间: </span
            ><span class="ui en">Joined </span>
            {{ new Date((user.create_time ?? 0) * 1000).toLocaleDateString() }}
          </span>
        </div>
      </div>
    </div>
    <div v-if="showAction" class="useraction">
      <div>
        <img src="/res/edit.svg" /><span class="ui zh">编辑资料</span
        ><span class="ui en">Edit profile</span>
        <ul>
          <li @click="userAction('changeName')">
            <span class="ui zh">修改昵称</span
            ><span class="ui en">Change nickname</span>
          </li>
          <li @click="userAction('changeAvatar')">
            <span class="ui zh">修改头像</span
            ><span class="ui en">Change avatar</span>
          </li>
          <li @click="userAction('changeEmail')">
            <span class="ui zh">修改邮箱</span
            ><span class="ui en">Change email</span>
          </li>
          <li @click="userAction('changePassword')">
            <span class="ui zh">修改密码</span
            ><span class="ui en">Change password</span>
          </li>
        </ul>
      </div>
      <div>
        <img src="/res/logout.svg" /><span class="ui zh">退出登录</span
        ><span class="ui en">Log out</span>
        <ul>
          <li @click="userAction('logout')">
            <span class="ui zh">退出登录 (当前设备)</span
            ><span class="ui en">Log out (from this device)</span>
          </li>
          <li style="color: red" @click="userAction('resetToken')">
            <span class="ui zh">退出登录 (所有设备)</span
            ><span class="ui en">Log out (from all devices)</span>
          </li>
        </ul>
      </div>
      <div v-if="user.role === 'admin'" @click="openAdmin">
        <img src="/res/edit.svg" /><span class="ui zh">管理举报与留言</span
        ><span class="ui en">Moderation</span>
      </div>
    </div>
    <div
      v-for="(item, index) in comments"
      :key="`${item.source ?? ''}-${item.id}`"
      class="userCommentItem"
    >
      <p>
        {{ item.timeStr
        }}<span>#{{ item.number ?? item.displayId ?? item.id }}</span>
      </p>
      <p>
        <span @click="gotoComment(index)">{{ item.comment }}</span>
        <i></i>
        <img
          v-for="image in item.images"
          :key="image"
          :src="`/api/data/images/posts/${image}.jpg`"
          loading="lazy"
          @click="viewImageUrl(`/api/data/images/posts/${image}.jpg`)"
        />
      </p>
    </div>
    <h4 v-if="toEnd">
      <span class="ui zh">- 共 {{ comments.length }} 条留言 -</span>
      <span class="ui en">- Total {{ comments.length }} messages -</span>
    </h4>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { avatarPath, runProfileAction } from '../../features/auth/auth-actions'
import { authStore, type UserProfile } from '../../features/auth/auth-store'
import { commentsApi } from '../../features/comments/comments-api'
import { commentsStore } from '../../features/comments/comments-store'
import XHR from '../../net/xhr'
import FloatMsgs from '../FloatMsgs'
import ImgViewer from '../ImgViewer'
import Popups from './index'

interface UserComment {
  id: number
  number?: number
  displayId?: number
  source?: string
  time: number
  timeStr?: string
  comment: string
  image?: string
  images: string[]
}

const props = defineProps<{
  id?: string
  name?: string
  avatar?: string
}>()

const user = ref<UserProfile>({
  id: props.id ?? '',
  name: props.name ?? '',
  avatar: props.avatar ?? '',
  create_time: 0,
})
const showAction = ref(true)
const comments = ref<UserComment[]>([])
const scrollPaused = ref(false)
const toEnd = ref(false)
const nextCursor = ref<number | null>(null)

function convertAvatarPath(path: string): string {
  return avatarPath(path)
}

function viewUserAvatar(): void {
  ImgViewer.view(convertAvatarPath(user.value.avatar))
}

function viewImageUrl(url: string): void {
  ImgViewer.view(url)
}

function userAction(
  action:
    | 'changeName'
    | 'changeAvatar'
    | 'changeEmail'
    | 'changePassword'
    | 'logout'
    | 'resetToken',
): void {
  runProfileAction(action)
}

function openAdmin(): void {
  Popups.show('adminPanel')
}

async function getComments(): Promise<void> {
  scrollPaused.value = true
  try {
    const page = await commentsApi.listUser(
      user.value.id,
      nextCursor.value ?? undefined,
    )

    for (const raw of page.items) {
      const date = new Date(raw.time * 1000)
      comments.value.push({
        id: raw.id,
        number: raw.number,
        comment: raw.comment,
        image: raw.image,
        time: raw.time,
        timeStr: `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`,
        images: raw.image ? raw.image.split(',') : [],
      })
    }

    const cursor =
      page.nextCursor ??
      (page.items.length > 0 ? (page.items.at(-1)?.id ?? null) : null)
    if (page.hasMore && cursor) {
      nextCursor.value = cursor
      scrollPaused.value = false
      if (page.items.length === 0) await getComments()
    } else {
      toEnd.value = true
      nextCursor.value = null
    }
  } catch {
    scrollPaused.value = false
  }
}

async function getUser(): Promise<void> {
  const response = await XHR.get<UserProfile | UserProfile[]>(
    props.id ? 'user/find' : 'user/me',
    { id: props.id },
  )
  const profile = Array.isArray(response) ? response[0] : response
  if (!profile) {
    FloatMsgs.show({
      type: 'warn',
      msg: `<span class="ui zh">找不到用户</span><span class="ui en">User not found</span> (ID: ${props.id ?? ''})`,
    })
    return
  }
  user.value = profile
  showAction.value = profile.id === authStore.state.userId
  await getComments()
}

function handleScroll(event: Event): void {
  if (scrollPaused.value) return
  const element = event.currentTarget as HTMLElement
  const distance =
    element.scrollHeight - element.clientHeight - element.scrollTop
  if (distance < 100) void getComments()
}

function gotoComment(index: number): void {
  const comment = comments.value[index]
  if (!comment) return
  void commentsStore.gotoNumber(comment.number ?? comment.id)
  Popups.close()
}

onMounted(() => {
  void getUser()
})
</script>
