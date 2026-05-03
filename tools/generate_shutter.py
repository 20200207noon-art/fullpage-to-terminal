#!/usr/bin/env python3
"""
生成相机咔嚓声 shutter.wav

设计原则：
- 所有频率内容在 1500 Hz 以上（避免低频"放屁声"）
- 两段 sine 振荡器（mirror up + mirror down）模拟反光镜动作
- 叠加 inharmonic 谐波（×1.6, ×2.71）做出金属共鸣感
- 高频噪声 burst 增加"咔"的颗粒感
- 末尾用 1500 Hz FIR 高通滤波保险

跑法：
    python3 tools/generate_shutter.py
输出：
    fullpage-shot/shutter.wav
"""

import os
import struct
import wave
import numpy as np

SAMPLE_RATE = 44100
DURATION = 0.20           # 总时长 200 ms
HIGHPASS_CUTOFF = 1500.0  # Hz

OUT_PATH = os.path.join(os.path.dirname(__file__), "..", "shutter.wav")


def osc_burst(t_axis, t_start, f0, tau, attack=0.0015, harmonics=(1.0, 1.4, 2.0), gains=(1.0, 0.30, 0.12)):
    """单段振荡 burst：温和 attack + 指数衰减 + 较纯 harmonic 谐波（不再用 inharmonic 金属感）。"""
    out = np.zeros_like(t_axis)
    rel = t_axis - t_start
    active = rel >= 0
    rel_a = np.where(active, rel, 0.0)

    # 衰减包络：上升段（attack）+ 指数衰减
    env_attack = np.clip(rel_a / attack, 0.0, 1.0)
    env_decay = np.exp(-rel_a / tau)
    env = env_attack * env_decay

    for h, g in zip(harmonics, gains):
        out += g * np.sin(2 * np.pi * f0 * h * rel_a)

    return active * env * out


def noise_burst(t_axis, t_start, tau, attack=0.0010, seed=42):
    """温和噪声 burst（attack 拉长到 1ms，避免"啪"的瞬态颗粒）。"""
    rel = t_axis - t_start
    active = rel >= 0
    rel_a = np.where(active, rel, 0.0)
    env_attack = np.clip(rel_a / attack, 0.0, 1.0)
    env_decay = np.exp(-rel_a / tau)
    env = env_attack * env_decay
    rng = np.random.default_rng(seed=seed)
    noise = rng.standard_normal(len(t_axis))
    return active * env * noise


def fir_highpass(signal, cutoff_hz, sample_rate, num_taps=257):
    """
    手写 FIR 高通滤波（Hamming 窗 windowed-sinc）。
    设计成 linear phase，不依赖 scipy。
    """
    if num_taps % 2 == 0:
        num_taps += 1
    n = np.arange(num_taps)
    m = (num_taps - 1) / 2.0
    fc = cutoff_hz / sample_rate  # normalized
    # 理想 sinc 低通
    h_lp = np.sinc(2 * fc * (n - m))
    # Hamming 窗
    window = 0.54 - 0.46 * np.cos(2 * np.pi * n / (num_taps - 1))
    h_lp *= window
    h_lp /= h_lp.sum()
    # 谱反转得到高通
    h_hp = -h_lp
    h_hp[int(m)] += 1.0
    # 卷积
    y = np.convolve(signal, h_hp, mode="same")
    return y


def normalize(signal, peak=0.85):
    m = np.max(np.abs(signal))
    if m < 1e-12:
        return signal
    return signal * (peak / m)


def main():
    n_samples = int(DURATION * SAMPLE_RATE)
    t = np.arange(n_samples) / SAMPLE_RATE

    # 第 1 段（mirror up）：温和高频，t=0
    s1 = osc_burst(t, t_start=0.000, f0=2400.0, tau=0.012, attack=0.0015)
    # 第 2 段（mirror down）：略低、更暖、更长，t=95ms
    s2 = osc_burst(t, t_start=0.095, f0=1600.0, tau=0.025, attack=0.0020)

    # 温和噪声 burst：显著降低音量、attack 拉长，提供"咔"颗粒感但不刺耳
    n1 = noise_burst(t, t_start=0.000, tau=0.006)
    n2 = noise_burst(t, t_start=0.095, tau=0.010, seed=137)

    # 混合（噪声大幅降低）
    sig = 0.95 * s1 + 0.80 * s2 + 0.18 * n1 + 0.14 * n2

    # 1500 Hz 高通滤波（保险，杀掉所有低频内容）
    sig = fir_highpass(sig, HIGHPASS_CUTOFF, SAMPLE_RATE)

    # 末尾微淡出，防止 click
    fade = int(0.005 * SAMPLE_RATE)
    sig[-fade:] *= np.linspace(1.0, 0.0, fade)

    sig = normalize(sig, peak=0.65)

    # 写 16-bit PCM mono WAV
    pcm = np.clip(sig * 32767.0, -32768, 32767).astype(np.int16)
    out_path = os.path.abspath(OUT_PATH)
    with wave.open(out_path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm.tobytes())

    # 自验：FFT 看低频含量
    spec = np.abs(np.fft.rfft(sig))
    freqs = np.fft.rfftfreq(len(sig), 1.0 / SAMPLE_RATE)
    total = spec.sum() + 1e-12
    below_1500 = spec[freqs < 1500].sum() / total
    peak_freq = freqs[np.argmax(spec)]

    print(f"wrote {out_path}  ({len(pcm)} samples, {DURATION*1000:.0f} ms)")
    print(f"peak frequency  : {peak_freq:.0f} Hz")
    print(f"energy < 1500Hz : {below_1500*100:.3f}%  (must be ~0)")


if __name__ == "__main__":
    main()
