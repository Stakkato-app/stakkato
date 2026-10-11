# Amp sounds: credits and licences

The amps on guitar takes (Clean, Crunch, Metal) are built from free, community-made
sounds. Each file keeps its own licence. The takes themselves are always stored dry;
these are only applied when a take plays.

## Amp captures (Neural Amp Modeler models), GNU GPL v3

From the NAM community collection at https://github.com/pelennor2170/NAM_models,
made by members of the Neural Amp Modeler Facebook group and licensed under the GNU
General Public License v3 (see `COPYING-GPL-3.0.txt` in this folder).

| File         | Original file                              | By       |
|--------------|--------------------------------------------|----------|
| `clean.nam`  | `Tim R Fender TwinVerb Norm Bright.nam`    | Tim R    |
| `crunch.nam` | `Tim R JCM2000 Crunch.nam`                 | Tim R    |
| `metal.nam`  | `Helga B 6505+ Red ch - MXR Drive.nam`     | Helga B  |

Changed: the files are rewritten as compact JSON with each weight written with 9
significant digits, which gives back exactly the same 32-bit float values. Nothing
else is changed. These files are their own source; the originals are at the link above.

## Speaker cabinet impulse responses, CC BY 4.0

By Kristoffer Ekstrand, Adventure Kid Research & Technology
(https://www.adventurekid.se/akrt/), licensed under the Creative Commons Attribution
4.0 International licence (https://creativecommons.org/licenses/by/4.0/). Taken from
the copies in ToobAmp (https://github.com/rerdavies/ToobAmp, `impulseFiles/CabIR`).

| File             | Original file          |
|------------------|------------------------|
| `cab-clean.wav`  | `Vintage US 001.wav`   |
| `cab-crunch.wav` | `Vintage UK 002.wav`   |
| `cab-metal.wav`  | `Modern US 002.wav`    |

Changed: the silence before the impulse is cut (8 samples are kept), the file is
resampled from 44.1 to 48 kHz, its level is normalised and the last 256 samples fade out.

## Room on the clean amp, CC BY 4.0

`room.wav` is made from "St. Margaret's Church" by www.openairlib.net, AudioLab,
University of York, and www.ncem.co.uk, from the OpenAIR library
(https://www.openair.hosted.york.ac.uk/?page_id=702), licensed under the Creative
Commons Attribution 4.0 International licence.

Changed: the B-format recording is turned into stereo (W + Y and W - Y), the direct sound
is taken out (the first 8 ms after it arrives, then a 12 ms fade-in), it is cut to 1.8 s
with a fade-out, resampled to 48 kHz and normalised.

## The engine, MIT

- Neural Amp Modeler core, https://github.com/sdatkinson/NeuralAmpModelerCore,
  Copyright (c) 2023 Steven Atkinson, MIT licence.
- nam-web (the WebAssembly build and AudioWorklet), https://github.com/HappySoftwareLabs/nam-web,
  Copyright (c) 2026 Devan R / Happy Software, MIT licence. It includes Eigen (MPL 2.0)
  and nlohmann/json (MIT).

MIT licence: Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal in the
Software without restriction, including without limitation the rights to use, copy,
modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to the following
conditions: The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT
WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN
AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
