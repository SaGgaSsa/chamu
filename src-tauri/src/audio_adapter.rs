//! Native microphone capture using CPAL.
//!
//! The adapter keeps captured audio in memory, converts the device's native
//! sample format to mono PCM16 and resamples it to 16 kHz before handing it to
//! the local dictation pipeline.

pub fn convert_interleaved_to_mono_16k(input: &[f32], channels: u16, sample_rate: u32) -> Vec<i16> {
    let channels = usize::from(channels.max(1));
    let mono: Vec<f32> = input.chunks(channels)
        .map(|frame| frame.iter().copied().sum::<f32>() / frame.len() as f32).collect();
    if mono.is_empty() || sample_rate == 0 { return Vec::new(); }
    let output_len = ((mono.len().saturating_sub(1) as u64 * 16_000) / sample_rate as u64 + 1) as usize;
    (0..output_len).map(|index| {
        let position = index as f64 * sample_rate as f64 / 16_000.0;
        let before = position.floor() as usize;
        let after = (before + 1).min(mono.len() - 1);
        let sample = mono[before] + (mono[after] - mono[before]) * (position - before as f64) as f32;
        let sample = sample.clamp(-1.0, 1.0);
        if sample <= -1.0 {
            i16::MIN
        } else if sample >= 1.0 {
            i16::MAX
        } else {
            (sample * i16::MAX as f32).round() as i16
        }
    }).collect()
}

/// Converts signed 16-bit device samples into the canonical in-memory format.
pub fn convert_interleaved_i16_to_mono_16k(
    input: &[i16],
    channels: u16,
    sample_rate: u32,
) -> Vec<i16> {
    let normalized = input
        .iter()
        .map(|sample| if *sample == i16::MAX { 1.0 } else { *sample as f32 / 32_768.0 })
        .collect::<Vec<_>>();
    convert_interleaved_to_mono_16k(&normalized, channels, sample_rate)
}

/// Converts unsigned 16-bit device samples (whose midpoint is silence) into
/// the canonical in-memory format.
pub fn convert_interleaved_u16_to_mono_16k(
    input: &[u16],
    channels: u16,
    sample_rate: u32,
) -> Vec<i16> {
    let normalized = input
        .iter()
        .map(|sample| {
            if *sample == u16::MAX { 1.0 } else { (*sample as f32 - 32_768.0) / 32_767.0 }
        })
        .collect::<Vec<_>>();
    convert_interleaved_to_mono_16k(&normalized, channels, sample_rate)
}

/// Converts an arbitrary CPAL integer sample into a normalized float.  The
/// callback adapters use this for less common hardware formats while keeping
/// all resampling and channel mixing in one implementation.
pub fn convert_interleaved_i32_to_mono_16k(
    input: &[i32],
    channels: u16,
    sample_rate: u32,
) -> Vec<i16> {
    let normalized = input
        .iter()
        .map(|sample| *sample as f32 / 2_147_483_648.0)
        .collect::<Vec<_>>();
    convert_interleaved_to_mono_16k(&normalized, channels, sample_rate)
}

pub fn convert_interleaved_u32_to_mono_16k(
    input: &[u32],
    channels: u16,
    sample_rate: u32,
) -> Vec<i16> {
    let normalized = input
        .iter()
        .map(|sample| (*sample as f64 - 2_147_483_648.0) as f32 / 2_147_483_648.0)
        .collect::<Vec<_>>();
    convert_interleaved_to_mono_16k(&normalized, channels, sample_rate)
}

pub fn convert_interleaved_f64_to_mono_16k(
    input: &[f64],
    channels: u16,
    sample_rate: u32,
) -> Vec<i16> {
    let normalized = input.iter().map(|sample| *sample as f32).collect::<Vec<_>>();
    convert_interleaved_to_mono_16k(&normalized, channels, sample_rate)
}

pub fn convert_interleaved_f32_to_mono_16k(input: &[f32], channels: u16, sample_rate: u32) -> Vec<i16> {
    convert_interleaved_to_mono_16k(input, channels, sample_rate)
}

pub fn convert_interleaved_i8_to_mono_16k(input: &[i8], channels: u16, sample_rate: u32) -> Vec<i16> {
    convert_interleaved_to_mono_16k(&input.iter().map(|v| *v as f32 / 128.0).collect::<Vec<_>>(), channels, sample_rate)
}

pub fn convert_interleaved_u8_to_mono_16k(input: &[u8], channels: u16, sample_rate: u32) -> Vec<i16> {
    convert_interleaved_to_mono_16k(&input.iter().map(|v| (*v as f32 - 128.0) / 128.0).collect::<Vec<_>>(), channels, sample_rate)
}

pub fn convert_interleaved_i64_to_mono_16k(input: &[i64], channels: u16, sample_rate: u32) -> Vec<i16> {
    convert_interleaved_to_mono_16k(&input.iter().map(|v| *v as f64 as f32 / i64::MAX as f32).collect::<Vec<_>>(), channels, sample_rate)
}

pub fn convert_interleaved_u64_to_mono_16k(input: &[u64], channels: u16, sample_rate: u32) -> Vec<i16> {
    convert_interleaved_to_mono_16k(&input.iter().map(|v| (*v as f64 - (u64::MAX as f64 / 2.0)) as f32 / (u64::MAX as f64 / 2.0) as f32).collect::<Vec<_>>(), channels, sample_rate)
}

#[cfg(test)]
mod tests {
    use super::convert_interleaved_to_mono_16k;

    #[test]
    fn conversion_clamps_float_pcm_to_signed_16_bit() {
        let samples = convert_interleaved_to_mono_16k(&[-1.0_f32, 0.0, 1.0], 1, 16_000);
        assert_eq!(samples, vec![i16::MIN, 0, i16::MAX]);
    }

    #[test]
    fn conversion_averages_interleaved_stereo_to_mono() {
        let samples = convert_interleaved_to_mono_16k(
            &[1.0_f32, -1.0, 0.5, 0.5],
            2,
            16_000,
        );
        assert_eq!(samples, vec![0, 16_384]);
    }

    #[test]
    fn conversion_resamples_eight_khz_to_sixteen_khz() {
        let samples = convert_interleaved_to_mono_16k(&[0.0_f32, 1.0], 1, 8_000);
        assert_eq!(samples, vec![0, 16_384, i16::MAX]);
    }

    #[test]
    fn conversion_supports_signed_and_unsigned_device_samples() {
        assert_eq!(
            super::convert_interleaved_i16_to_mono_16k(
                &[i16::MIN, 0, i16::MAX],
                1,
                16_000,
            ),
            vec![i16::MIN, 0, i16::MAX]
        );
        assert_eq!(
            super::convert_interleaved_u16_to_mono_16k(&[0, 32_768, u16::MAX], 1, 16_000),
            vec![i16::MIN, 0, i16::MAX]
        );
    }
}
