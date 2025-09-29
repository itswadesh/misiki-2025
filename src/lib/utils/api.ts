let typingTimer
const send = async ({ method, path, params, data, token, headers }: any) => {
  if (
    path.includes('.png') ||
    path.includes('.jpg') ||
    path.includes('.svg') ||
    path.includes('.json') ||
    path.includes('.css')
  )
    return
  const WWW_URL = import.meta.env.VITE_WWW_URL || 'https://misiki.in'
  let origin = WWW_URL

  if (headers && headers.get('cookie') && headers.get('cookie').includes('store')) {
    origin = headers.get('origin') || headers.get('host')
    if (origin === 'localhost:3000') origin = 'http://localhost:3000'
    else origin = 'https://' + origin
  } else {
  }
  let uri = new URL(path, WWW_URL)

  if (!path.includes('http://')) {
    // When microservice path provided
    uri = new URL('api/' + path, origin)
  }
  const opts: any = {
    method,
  }
  opts.headers = headers ? headers : { Cache: 'no-cache' }
  if (data) {
    const contentType = data?.files && data?.files[0]?.type
    if (
      !(
        contentType === 'image/jpeg' ||
        contentType === 'image/gif' ||
        contentType === 'image/png' ||
        contentType === 'image/ico' ||
        contentType === 'image/webp' ||
        contentType === 'application/pdf' ||
        contentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        contentType === 'application/msword' ||
        contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      )
    ) {
      opts.headers['Content-Type'] = 'application/json'
      opts.body = JSON.stringify(data)
    } else {
      const form = new FormData()
      if (data && data.files) {
        for (let x of data.files) {
          form.append('files', x)
        }
      }
      for (let d in data) {
        if (d !== 'files') form.append(d, data[d])
      }
      opts.body = form
    }
  }
  if (token) {
    opts.headers['Authorization'] = `Bearer ${token}`
  }
  // else if (tkn) {
  // 	opts.headers['Authorization'] = `Bearer ${tkn}`
  // }

  if (!params) params = {}

  if (params) {
    Object.keys(params).forEach((key) => uri.searchParams.append(key, params[key]))
  }
  try {
    const url = uri.toString()
    // console.log(url, opts)
    let response = await fetch(url, opts)
    const isJson = response.headers.get('content-type')?.includes('application/json')

    const res = isJson ? await response.json() : await response.text()
    // console.log(res)
    if (res?.status > 400) {
      throw { status: res.status, message: res }
    } else if (response?.status > 400) {
      throw { status: response.status, message: res }
    } else {
      return res
    }
  } catch (e) {
    throw e
  }
}

export const getAPI = (path, headers?) => {
  return send({ method: 'GET', path, headers })
}

export const del = (path, data, headers?) => {
  return send({ method: 'DELETE', path, data, headers })
}

export const post = (path, data, headers?) => {
  // KPTHMS => 4.168
  // HAL3 => 80.50
  // IFSWEB => 80.80
  return send({ method: 'POST', path, data, headers })
}

export const put = (path, data, headers?) => {
  return send({ method: 'PUT', path, data, headers })
}

const startDelayedLoadingIndicator = async () => {
  clearTimeout(typingTimer)
  typingTimer = setTimeout(() => {
    // loadingDelayed.set(true)
  }, 5000)
}

const cancelDelayedLoadingIndicator = async () => {
  clearTimeout(typingTimer)
  // loadingDelayed.set(false)
}
