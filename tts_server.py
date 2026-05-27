import io
import torch
import numpy as np
import ChatTTS
from flask import Flask, request, send_file, jsonify

app = Flask(__name__)

print("Loading ChatTTS model...")
chat = ChatTTS.Chat()
chat.load(compile=False)
print("ChatTTS model loaded!")

# 丞相专用说话人嵌入 (儒雅男声风格)
def get_speaker():
    torch.manual_seed(42)
    return chat.sample_random_speaker()

@app.route('/api/tts', methods=['POST'])
def tts():
    data = request.get_json()
    text = data.get('text', '')
    if not text:
        return jsonify({'error': '缺少 text 参数'}), 400

    try:
        params_infer = ChatTTS.Chat.InferCodeParams(
            spk_emb=get_speaker(),
            temperature=0.3,
            top_P=0.7,
            top_K=20,
        )
        params_refine = ChatTTS.Chat.RefineTextParams(
            prompt='[oral_2][laugh_0][break_6]',
        )

        wavs = chat.infer(
            [text],
            params_infer_code=params_infer,
            params_refine_text=params_refine,
            use_decoder=True,
        )

        audio_data = wavs[0]
        if isinstance(audio_tensor := audio_data, torch.Tensor):
            audio_np = audio_tensor.cpu().numpy()
        else:
            audio_np = np.array(audio_data)

        audio_np = audio_np.squeeze()
        if audio_np.max() > 1.0:
            audio_np = audio_np / np.abs(audio_np).max()

        sample_rate = 24000
        import soundfile as sf
        buf = io.BytesIO()
        sf.write(buf, audio_np, sample_rate, format='WAV')
        buf.seek(0)

        return send_file(buf, mimetype='audio/wav')

    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/tts/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok', 'model': 'ChatTTS'})

if __name__ == '__main__':
    print("Starting ChatTTS server on port 5050...")
    app.run(host='127.0.0.1', port=5050, debug=False)
