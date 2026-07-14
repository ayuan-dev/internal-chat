const CONNECTION_STATES = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  FAILED: 'failed',
  CLOSED: 'closed'
};

connOption = 
{ 
  ordered: true, 
  // 强局域网场景：使用完全可靠有序通道，由 SCTP 自身保证送达，去掉弱网专用的部分可靠/重传参数
  bufferedAmountLowThreshold: 1024 * 1024 // 缓冲区低阈值 1MB，与 checkBufferedAmount 的 8MB 上限形成流水线窗口
}

window.fgdx_configuration = {
  iceServers: [
    {
      urls: [
        'stun:74.125.250.129:19302'
      ]
    }
  ],
  iceTransportPolicy: 'all',        // 允许所有类型的候选者
  iceCandidatePoolSize: 10           // 预生成的候选者数量
};

class XChatUser {
  id = null;
  roomId = null;
  isMe = false;
  nickname = null;

  rtcConn = null;
  connAddressTarget = null;
  connAddressMe = null;
  chatChannel = null;
  candidateArr = [];

  onicecandidate = () => { };
  onmessage = () => { };
  onReviceFile = () => { };
  onConnectionStateChange = () => { };

  receivedSize = 0;
  receivedChunks = null;
  fileInfo = null;

  // 接收端流式落盘状态
  useStreaming = false;       // 是否走 File System Access 直接写盘
  fileWritable = null;        // 可写文件句柄（showSaveFilePicker 得到）
  onReceiveFileRequest = null; // 由 UI 注入：返回可写句柄 / null(内存回退) / false(拒绝)

  connectionPromise = null;

  #isTransferCancelled = false;
  #transferTimeout = null;
  #maxRetries = 3;

  // 分块大小根据 SCTP 支持的最大消息体动态决定（现代浏览器通常 256KB），远优于写死的 8KB
  #getChunkSize() {
    const max = this.rtcConn?.sctp?.maxMessageSize || 65536;
    return Math.max(16 * 1024, Math.min(max, 256 * 1024));
  }


  async createConnection() {
    const peerConnectionConstraints = {
      optional: [
        { googIPv6: false }
      ]
    };
    
    this.rtcConn = new RTCPeerConnection(window.fgdx_configuration, peerConnectionConstraints);
    this.chatChannel = this.rtcConn.createDataChannel('chat',  connOption);
    this.dataChannel_initEvent()
    // this.dataChannel.onopen = () => console.log('DataChannel is open');
    // this.dataChannel.onclose = () => console.log('DataChannel is closed');
    const offer = this.rtcConn.createOffer()
    await this.rtcConn.setLocalDescription(offer)
    this.connAddressMe = this.rtcConn.localDescription;

    this.rtcConn.onicecandidateerror = (event) => {
      console.error('ICE Candidate Error:', event, {
        errorCode: event.errorCode,
        errorText: event.errorText,
        hostCandidate: event.hostCandidate,
        url: event.url
      });
    };

    this.rtcConn.onicegatheringstatechange = () => {
      const state = this.rtcConn.iceGatheringState;
      console.log(`ICE gathering state changed: ${state}`);
      
      switch(state) {
        case 'new':
          console.log('Starting to gather candidates...');
          break;
        case 'gathering':
          console.log('Gathering ICE candidates...');
          break;
        case 'complete':
          console.log('ICE gathering completed');
          console.log('Final candidates:', this.candidateArr);
          break;
      }
    };

    this.rtcConn.oniceconnectionstatechange = () => {
      console.log(`ICE connection state: ${this.rtcConn.iceConnectionState}`);
    };
    if (this.rtcConn.connectionState) {
      this.rtcConn.onconnectionstatechange = () => {
        this.onConnectionStateChange(this.rtcConn.connectionState);
      };
    } else {
      // firefox没有connectionState，也不支持onConnectionStateChange
      this.rtcConn.oniceconnectionstatechange = this.rtcConn.onsignalingstatechange = () => {
        this.onConnectionStateChange(this.getConnectionState());
      };
    }

    this.rtcConn.onicecandidate = event => {
      if (event.candidate) {
        console.log('ICE Candidate Details:', {
          candidate: event.candidate.candidate,
          type: event.candidate.type,
          protocol: event.candidate.protocol,
          address: event.candidate.address,
          port: event.candidate.port,
          priority: event.candidate.priority,
          foundation: event.candidate.foundation,
          relatedAddress: event.candidate.relatedAddress,
          relatedPort: event.candidate.relatedPort
        });
        this.candidateArr.push(event.candidate);
        this.onicecandidate(event.candidate, this.candidateArr);
      } else {
        console.log('ICE gathering completed');
      }
    };

    return this;
  }

  closeConnection() {
    if (this.rtcConn) {
      this.rtcConn.onconnectionstatechange = null;
      this.rtcConn.close();
    }
    this.rtcConn = null;
    this.chatChannel = null;
    this.connAddressTarget = null;
    this.connAddressMe = null;
    this.onicecandidate = () => { };
    this.onConnectionStateChange(CONNECTION_STATES.CLOSED);
  }

  async connectTarget(target) {
    if (!target) {
      throw new Error('connAddressTarget is null');
    }
    if (this.isMe || !this.id) {
      return this;
    }

    if (this.rtcConn) {
      this.closeConnection();
    }

    this.rtcConn = new RTCPeerConnection(window.fgdx_configuration);

    this.rtcConn.onicecandidate = event => {
      if (event.candidate) {
        this.candidateArr.push(event.candidate);
        this.onicecandidate(event.candidate, this.candidateArr);
      }
    };
    this.rtcConn.ondatachannel = (event) => {
      if (event.channel) {
        this.chatChannel = event.channel;
        this.dataChannel_initEvent();
      }
    };
    this.connAddressTarget = new RTCSessionDescription({ type: 'offer', sdp: target});
    await this.rtcConn.setRemoteDescription(this.connAddressTarget);
    
    this.connAddressMe = await this.rtcConn.createAnswer();
    this.rtcConn.setLocalDescription(this.connAddressMe);

    if (this.rtcConn.connectionState) {
      this.rtcConn.onconnectionstatechange = () => {
        console.log(`Connection state changed: ${this.rtcConn.connectionState}`);
        this.onConnectionStateChange(this.rtcConn.connectionState);
        if (this.rtcConn.connectionState === 'failed') {
          console.log('Connection failed, attempting to reconnect...');
          this.reconnect();
        }
      };
    } else {
      // firefox没有connectionState，也不支持onConnectionStateChange
      this.rtcConn.oniceconnectionstatechange = this.rtcConn.onsignalingstatechange = () => {
        this.onConnectionStateChange(this.getConnectionState());
      };
    }

    return this;
  }

  getConnectionState() {
    if (!this.rtcConn) {
      return null;
    }
    if (this.rtcConn.connectionstate) {
      return this.rtcConn.connectionState;
    } else {
      let firefoxConnectionState = 'new';
      // 根据 iceConnectionState 和 signalingState 推断状态
      if (this.rtcConn.iceConnectionState === 'connected' || this.rtcConn.iceConnectionState === 'completed') {
        if (this.rtcConn.signalingState === 'stable') {
          firefoxConnectionState = 'connected';
        } else {
          firefoxConnectionState = 'connecting';
        }
      } else if (this.rtcConn.iceConnectionState === 'disconnected') {
        firefoxConnectionState = 'disconnected';
      } else if (this.rtcConn.iceConnectionState === 'failed') {
        firefoxConnectionState = 'failed';
      } else if (this.rtcConn.iceConnectionState === 'closed') {
        firefoxConnectionState = 'closed';
      } else if (this.rtcConn.iceConnectionState === 'new') {
        firefoxConnectionState = 'new';
      }
      return firefoxConnectionState;
    }
  }

  addIceCandidate(candidate) {
    if (!this.rtcConn) {
      return;
    }
    this.rtcConn.addIceCandidate(new RTCIceCandidate(candidate))
  }

  async setRemoteSdp(target) {
    if (this.rtcConn.signalingState === 'have-local-offer' && !this.rtcConn.remoteDescription) {
      // console.log('setRemoteDescription', target);
      try {

        this.rtcConn.setRemoteDescription({ type: 'answer', sdp: target})
        .then(() => console.log('Remote SDP set as answer.'))
        .catch(err => console.error('Error handling answer SDP:', err));
      } catch (err) {
        console.error('Error handling answer SDP:', err);
      }
    } else {
      // console.error('Cannot set answer SDP: signaling state is', peerConnection.signalingState);
    }
  }

  dataChannel_initEvent() {
    this.chatChannel.onmessage = async e => {
      const message = e.data;
      
      try {
        if (typeof message === 'string') {
          if (message.startsWith('##FILE_S##')) {
            // 收到文件头：请求用户确认保存位置，确认后再回 ACK，发送端才开传
            this.fileInfo = JSON.parse(message.substring(10));
            this.receivedSize = 0;
            this.useStreaming = false;
            this.fileWritable = null;
            this.receivedChunks = null;
            this.#setTransferTimeout();

            let target = null;
            if (this.onReceiveFileRequest) {
              try {
                target = await this.onReceiveFileRequest(this.fileInfo);
              } catch (_) {
                target = null;
              }
            }
            if (target === false) {
              // 用户拒绝：通知发送端立即中止，无需等待超时
              try { await this.sendMessage('##FILE_REJECT##'); } catch (_) { }
              return;
            }
            if (target) {
              this.useStreaming = true;
              this.fileWritable = target;
            } else {
              this.receivedChunks = []; // 回退：在内存中攒块
            }
            await this.sendMessage('##FILE_S_ACK##');
            return;
          }

          if (message === '##FILE_E##') {
            this.#clearTransferTimeout();
            if (this.useStreaming && this.fileWritable) {
              try { await this.fileWritable.close(); } catch (_) { }
              this.onReviceFile({ name: this.fileInfo.name, saved: true });
            } else if (this.receivedChunks) {
              try {
                const blob = new Blob(this.receivedChunks);
                const url = URL.createObjectURL(blob);
                this.onReviceFile({ url, name: this.fileInfo.name });
              } catch (error) {
                console.error('Error creating blob:', error);
              }
            }
            this.#cleanupTransfer();
            return;
          }

          // 其余字符串按普通消息处理（旧协议的控制消息与 ##FILE_REJECT## 一律忽略，保持兼容）
          try {
            if (message === '##FILE_REJECT##') return;
            const parsed = JSON.parse(message);
            if (parsed.type === '##CHUNK_INFO##' || parsed.type === '##RETRY_REQUEST##' || parsed.type === '##PROGRESS_ACK##') {
              return;
            }
          } catch (_) { }
          this.onmessage(message);
          return;
        }

        // 二进制：完全可靠有序通道下，每个二进制消息即为按序到达的一文件块
        if (this.fileWritable || this.receivedChunks) {
          this.#setTransferTimeout();
          let buffer;
          if (message instanceof ArrayBuffer) {
            buffer = message;
          } else if (message instanceof Uint8Array) {
            buffer = message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength);
          } else {
            buffer = message;
          }
          if (!buffer) return;
          this.receivedSize += buffer.byteLength;
          if (this.useStreaming && this.fileWritable) {
            await this.fileWritable.write(buffer);
          } else if (this.receivedChunks) {
            this.receivedChunks.push(buffer);
          }
        }
      } catch (error) {
        console.error('Error processing message:', error);
      }
    };

    this.chatChannel.onopen = () => console.log('chatChannel is open');
    this.chatChannel.onclose = () => console.log('DataChannel is closed');
  }
  checkBufferedAmount() {
    const maxBufferedAmount = 1024 * 1024 * 8; // 8MB 发送窗口，尽量吃满局域网带宽（原 64KB 是速度瓶颈）
    return new Promise(resolve => {
      if (this.chatChannel.bufferedAmount > maxBufferedAmount) {
        // 如果缓冲区超过阈值，等待 bufferedamountlow 事件
        const handleBufferedAmountLow = () => {
          this.chatChannel.removeEventListener('bufferedamountlow', handleBufferedAmountLow);
          resolve();
        };
        this.chatChannel.addEventListener('bufferedamountlow', handleBufferedAmountLow);
      } else {
        // 缓冲区未满，立即解析
        resolve();
      }
    });
  }
  async sendFileBytes(file, onProgress) {
    return new Promise((resolve, reject) => {
      const chunkSize = this.#getChunkSize();
      const totalChunks = Math.ceil(file.size / chunkSize);
      let currentChunk = 0;
      let totalSent = 0;
      let lastProgressUpdate = Date.now();
      let retryCount = 0;

      const sendChunk = async (chunkIndex) => {
        try {
          const start = chunkIndex * chunkSize;
          const end = Math.min(start + chunkSize, file.size);
          const chunk = file.slice(start, end);

          // 读取 chunk 数据
          const buffer = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsArrayBuffer(chunk);
          });

          // 发送实际数据（不再为每块发送 JSON 控制消息，可靠有序通道下按序即可）
          await this.checkBufferedAmount();
          this.chatChannel.send(buffer);

          totalSent += buffer.byteLength;

          // 更新进度
          const now = Date.now();
          if (now - lastProgressUpdate > 100) {
            if (onProgress) {
              onProgress(totalSent, file.size);
            }
            lastProgressUpdate = now;
          }

        } catch (e) {
          console.error(`Error sending chunk ${chunkIndex}:`, e);
          throw e;
        }
      };

      const processNextChunk = async () => {
        try {
          if (this.#isTransferCancelled) {
            return;
          }

          if (currentChunk < totalChunks) {
            await sendChunk(currentChunk);
            currentChunk++;
            setTimeout(processNextChunk, 0);
          } else {
            if (onProgress) {
              onProgress(totalSent, file.size);
            }
            resolve();
          }
        } catch (e) {
          if (retryCount < this.#maxRetries) {
            retryCount++;
            console.log(`Retrying chunk ${currentChunk}, attempt ${retryCount}`);
            setTimeout(processNextChunk, 1000); // 1秒后重试
          } else {
            reject(e);
          }
        }
      };

      processNextChunk();
    });
  }

  async sendFile(fileInfo, file, onProgress) {
    try {
      this.#isTransferCancelled = false;
      
      if (this.chatChannel.readyState !== 'open') {
        throw new Error('Connection not open');
      }

      // 发送文件信息并等待确认
      await this.sendMessage('##FILE_S##' + JSON.stringify(fileInfo));
      await new Promise((resolve, reject) => {
        // 等待接收方在弹窗里选择保存位置（用户手势），给足交互时间
        const timeout = setTimeout(() => reject(new Error('File start confirmation timeout')), 60000);
        const cleanup = () => {
          clearTimeout(timeout);
          this.chatChannel.removeEventListener('message', handler);
        };
        const handler = (e) => {
          if (e.data === '##FILE_S_ACK##') {
            cleanup();
            resolve();
          } else if (e.data === '##FILE_REJECT##') {
            cleanup();
            reject(new Error('对方拒绝了文件接收'));
          }
        };
        this.chatChannel.addEventListener('message', handler);
      });
      
      // 发送文件内容
      await this.sendFileBytes(file, onProgress);
      
      if (!this.#isTransferCancelled) {
        // 发送结束标记并等待确认
        await this.sendMessage('##FILE_E##');
        
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('File transfer confirmation timeout')), 30000); // 增加超时时间到30秒
          
          const confirmHandler = (e) => {
            if (e.data === '##FILE_RECEIVED##') {
              clearTimeout(timeout);
              this.chatChannel.removeEventListener('message', confirmHandler);
              resolve();
            }
          };
          
          this.chatChannel.addEventListener('message', confirmHandler);
        });
      }
    } catch (e) {
      console.error('Send file failed:', e);
      throw e;
    }
  }
  
  async sendMessage(message) {
    if (!this.chatChannel) {
      console.log(this.id, '------chatChannel is null');
      return;
    }
    if (this.chatChannel.readyState === 'open') {
      await this.chatChannel.send(message);
    } else {
      throw new Error('DataChannel is not open');
    }
  }

  // 添加取消传输方法
  cancelTransfer() {
    this.#isTransferCancelled = true;
    if (this.chatChannel) {
      // 关闭并重新创建数据通道，确保传输被中断
      this.chatChannel.close();
      this.createDataChannel();
    }
  }

  // 创建新的数据通道
  createDataChannel() {
    if (this.rtcConn) {
      this.chatChannel = this.rtcConn.createDataChannel('chat', connOption);
      this.dataChannel_initEvent();
    }
  }

  // 添加重连方法
  async reconnect() {
    console.log('Attempting to reconnect...');
    if (this.connAddressTarget) {
      try {
        await this.connectTarget(this.connAddressTarget.sdp);
      } catch (error) {
        console.error('Reconnection failed:', error);
      }
    }
  }

  // 获取当前连接状态
  getConnectionState() {
    if (!this.rtcConn) {
      return CONNECTION_STATES.DISCONNECTED;
    }
    return this.rtcConn.connectionState;
  }

  // 检查是否已连接
  isConnected() {
    if (!this.rtcConn) {
      return false;
    }
    if (this.rtcConn.connectionState) {
      return this.rtcConn.connectionState === 'connected';
    }
    if (this.rtcConn.iceConnectionState === 'connected' || this.rtcConn.iceConnectionState === 'completed') {
      if (this.rtcConn.signalingState === 'stable') {
        return true;
      }
    }
    return false;
  }



  #setTransferTimeout() {
    this.#clearTransferTimeout();
    this.#transferTimeout = setTimeout(() => {
      console.error('File transfer timeout');
      this.#cleanupTransfer();
    }, 30000); // 30秒超时
  }
  
  #clearTransferTimeout() {
    if (this.#transferTimeout) {
      clearTimeout(this.#transferTimeout);
      this.#transferTimeout = null;
    }
  }
  
  #cleanupTransfer() {
    this.#clearTransferTimeout();
    this.receivedChunks = null;
    this.receivedSize = 0;
    this.fileInfo = null;
    this.fileWritable = null;
    this.useStreaming = false;
  }
}