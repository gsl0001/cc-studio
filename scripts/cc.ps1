# cc - cc-studio's desktop companion: a small blob character whose "pony" shows the state, with chat, voice and controls.
# a footless, floating character whose halo colour and eyes show the pipeline's state, built
# from layers (scripts/cc-avatar.py -> cc-avatar/): body per accent colour, halo glow, eyes,
# effects. Accents: blue default, orange alert (videos to review), purple creative (making a
# video), red error, green success, teal calm (paused). Subtle motion only: a slow hover with
# its glow shadow, a slight sway, blinks and glances. Interactions: eyes follow the cursor,
# resting the cursor on cc makes it smile, a press squishes it, a drag surprises it, it looks
# toward the open chat; listening (Mic), speaking, thinking (waiting for an answer) and
# success/error each have their own face. The chat is built in (no browser window).
# Click: open/close the chat panel.  Drag: move (remembered).  Right-click: controls.
# cc speaks its replies and status changes with Kokoro, an offline neural voice served by
# scripts/voice.py (cc starts it; Windows' built-in voice covers while it loads or if it
# is gone). Mute in the panel or the right-click menu. The Mic button listens through
# Windows speech recognition.
# Talks to the desk server (src/server.js, http://127.0.0.1:4820) without blocking the UI.
# Started at login by the "cc" Startup shortcut (wscript scripts\hidden.vbs cc).
# ASCII only: Windows PowerShell 5.1 reads a BOM-less script as ANSI.
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Net.Http, System.Speech, System.Windows.Forms, System.Drawing
# Speech recognition events fire on a worker thread, where PowerShell can't run; this keeps
# the result in fields that a UI timer reads.
Add-Type -ReferencedAssemblies System.Speech -TypeDefinition @"
using System; using System.Speech.Recognition;
public class CcEar {
  SpeechRecognitionEngine e;
  public volatile string Heard; public volatile string Error; public volatile bool Listening; public volatile int Level;
  public CcEar() {
    e = new SpeechRecognitionEngine();
    e.SetInputToDefaultAudioDevice();
    e.LoadGrammar(new DictationGrammar());
    e.InitialSilenceTimeout = TimeSpan.FromSeconds(6);
    e.EndSilenceTimeout = TimeSpan.FromSeconds(1.2);
    e.SpeechRecognized += (s, a) => { Heard = a.Result.Text; };
    e.AudioLevelUpdated += (s, a) => { Level = a.AudioLevel; };
    e.RecognizeCompleted += (s, a) => { if (a.Error != null) Error = a.Error.Message; Listening = false; };
  }
  public void Listen() { Heard = null; Error = null; Listening = true; e.RecognizeAsync(RecognizeMode.Single); }
}
"@

Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class CcCursor {
  [StructLayout(LayoutKind.Sequential)] public struct P { public int X; public int Y; }
  [DllImport("user32.dll")] static extern bool GetCursorPos(out P p);
  public static int[] Get() { P p; GetCursorPos(out p); return new int[] { p.X, p.Y }; }
}
"@
$mutex = New-Object System.Threading.Mutex($false, "Local\cc_studio_cc")
if (-not $mutex.WaitOne(0)) { exit }   # one cc at a time

$Desk = "http://127.0.0.1:4820"
$VoiceUrl = "http://127.0.0.1:4821"
$Root = Split-Path $PSScriptRoot -Parent   # the cc-studio folder
$VoicePy = Join-Path $Root "voice\venv\Scripts\pythonw.exe"   # npm run voice:install
$VoiceScript = Join-Path $Root "scripts\voice.py"
$PosFile = Join-Path $env:APPDATA "cc-studio-cc.json"   # where cc sits, size, voice, colour (per user)

# The system log (src/log.js): one JSON line per entry, shared with every other part.
$LogFile = Join-Path $Root "logs\system.jsonl"
if (-not (Test-Path (Split-Path $LogFile))) { New-Item -ItemType Directory (Split-Path $LogFile) | Out-Null }
function Log($lvl, $msg, $extra) {
  $o = [ordered]@{ t = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"); src = "cc"; lvl = $lvl; msg = "$msg" }
  if ($extra) { foreach ($k in $extra.Keys) { $o[$k] = $extra[$k] } }
  $line = ($o | ConvertTo-Json -Compress) + "`n"
  # Another process may be appending at the same moment; a short retry, then give up quietly.
  for ($i = 0; $i -lt 3; $i++) { try { [IO.File]::AppendAllText($LogFile, $line); return } catch { Start-Sleep -Milliseconds 25 } }
}

[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="cc" SizeToContent="WidthAndHeight" WindowStyle="None" AllowsTransparency="True"
        Background="Transparent" Topmost="True" ShowInTaskbar="False" ResizeMode="NoResize"
        FontFamily="Segoe UI" UseLayoutRounding="True">
  <Window.Resources>
    <Style TargetType="Button">
      <Setter Property="Foreground" Value="#FFE4E4E7"/>
      <Setter Property="Background" Value="#FF27272A"/>
      <Setter Property="BorderBrush" Value="#FF3F3F46"/>
      <Setter Property="Padding" Value="12,5"/>
      <Setter Property="FontSize" Value="12.5"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Margin" Value="0,0,6,6"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="b" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}"
                    BorderThickness="1" CornerRadius="14" Padding="{TemplateBinding Padding}">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="b" Property="BorderBrush" Value="#FF71717A"/></Trigger>
              <Trigger Property="IsEnabled" Value="False"><Setter TargetName="b" Property="Opacity" Value="0.45"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <!-- Header icons: no frame until hovered. -->
    <Style x:Key="Icon" TargetType="Button">
      <Setter Property="Foreground" Value="#FFA1A1AA"/>
      <Setter Property="Width" Value="32"/>
      <Setter Property="Height" Value="32"/>
      <Setter Property="Margin" Value="2,0,0,0"/>
      <Setter Property="FontFamily" Value="Segoe Fluent Icons, Segoe MDL2 Assets"/>
      <Setter Property="FontSize" Value="13"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="b" Background="Transparent" CornerRadius="16">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="b" Property="Background" Value="#FF27272A"/>
                <Setter Property="Foreground" Value="#FFF4F4F5"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <!-- A slim dark scrollbar instead of the light Windows one. -->
    <Style TargetType="ScrollBar">
      <Setter Property="Width" Value="6"/>
      <Setter Property="MinWidth" Value="6"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="ScrollBar">
            <Track x:Name="PART_Track" IsDirectionReversed="True">
              <Track.Thumb>
                <Thumb>
                  <Thumb.Template>
                    <ControlTemplate TargetType="Thumb"><Border CornerRadius="3" Background="#FF3F3F46"/></ControlTemplate>
                  </Thumb.Template>
                </Thumb>
              </Track.Thumb>
            </Track>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
  </Window.Resources>
  <Grid>
    <Grid.ColumnDefinitions><ColumnDefinition Width="Auto"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>

    <Border x:Name="Panel" Grid.Column="0" Width="400" Height="620" Margin="14,14,2,16" CornerRadius="18"
            Background="#FF18181B" BorderBrush="#FF2E2E33" BorderThickness="1" VerticalAlignment="Bottom" Visibility="Collapsed">
      <Border.Effect><DropShadowEffect BlurRadius="24" ShadowDepth="4" Opacity="0.5" Color="Black"/></Border.Effect>
      <DockPanel LastChildFill="True">
        <Border DockPanel.Dock="Top" Padding="16,12,10,10" BorderBrush="#FF2E2E33" BorderThickness="0,0,0,1">
          <StackPanel>
            <DockPanel>
              <Button x:Name="CloseBtn" Style="{StaticResource Icon}" DockPanel.Dock="Right" ToolTip="Close"/>
              <Button x:Name="PauseBtn" Style="{StaticResource Icon}" DockPanel.Dock="Right"/>
              <Button x:Name="VoiceBtn" Style="{StaticResource Icon}" DockPanel.Dock="Right"/>
              <Button x:Name="CtrlBtn" Style="{StaticResource Icon}" DockPanel.Dock="Right" ToolTip="Controls"/>
              <Button x:Name="FolderBtn" Style="{StaticResource Icon}" DockPanel.Dock="Right" ToolTip="Folders"/>
              <StackPanel Orientation="Horizontal" VerticalAlignment="Center">
                <Border Width="36" Height="36" CornerRadius="18" Background="#FF27272A" Margin="0,0,10,0">
                  <Image x:Name="HeadFace" Margin="3" Stretch="Uniform" RenderOptions.BitmapScalingMode="HighQuality"/>
                </Border>
                <StackPanel VerticalAlignment="Center">
                  <TextBlock x:Name="NameText" Text="cc" FontWeight="SemiBold" FontSize="15" Foreground="#FFF4F4F5"/>
                  <StackPanel Orientation="Horizontal">
                    <Ellipse x:Name="StatusDot" Width="6" Height="6" Fill="#FF22C55E" Margin="0,1,6,0" VerticalAlignment="Center"/>
                    <TextBlock x:Name="StatusText" Text="Online" FontSize="11.5" Foreground="#FFA1A1AA"/>
                  </StackPanel>
                </StackPanel>
              </StackPanel>
            </DockPanel>
            <WrapPanel x:Name="Pills" Margin="0,10,0,0"/>
          </StackPanel>
        </Border>
        <Border DockPanel.Dock="Bottom" Padding="12,8,12,12">
          <Border CornerRadius="22" BorderBrush="#FF3F3F46" BorderThickness="1" Background="#FF27272A" Padding="16,5,5,5">
            <DockPanel>
              <Button x:Name="ActBtn" DockPanel.Dock="Right" Width="32" Height="32" Margin="6,0,0,0" Padding="0"
                      Background="#FFF4F4F5" BorderBrush="#FFF4F4F5" Foreground="#FF18181B"
                      FontFamily="Segoe Fluent Icons, Segoe MDL2 Assets" FontSize="14" ToolTip="Talk to cc"/>
              <Grid VerticalAlignment="Center">
                <TextBlock x:Name="Hint" Text="Ask cc anything" Foreground="#FF71717A" FontSize="13.5" IsHitTestVisible="False"
                           VerticalAlignment="Center" Margin="2,0,0,0"/>
                <TextBox x:Name="Input" BorderThickness="0" Background="Transparent" FontSize="13.5" Foreground="#FFF4F4F5" CaretBrush="#FFF4F4F5"
                         SelectionBrush="#FF71717A" VerticalContentAlignment="Center"/>
              </Grid>
            </DockPanel>
          </Border>
        </Border>
        <WrapPanel x:Name="Chips" DockPanel.Dock="Bottom" Margin="14,6,8,0"/>
        <ScrollViewer x:Name="Scroll" VerticalScrollBarVisibility="Auto" Padding="16,14,10,6">
          <StackPanel x:Name="Feed"/>
        </ScrollViewer>
      </DockPanel>
    </Border>

    <Grid x:Name="Stage" Grid.Column="1" VerticalAlignment="Bottom">
      <!-- A speech bubble over cc's head: a state dot, the line, and a tail pointing down at the halo. -->
      <StackPanel x:Name="Bubble" VerticalAlignment="Bottom" HorizontalAlignment="Left" Visibility="Collapsed" IsHitTestVisible="False">
        <Border CornerRadius="13" Background="#FF18181B" BorderBrush="#FF3F3F46" BorderThickness="1" Padding="11,7,13,7">
          <Border.Effect><DropShadowEffect BlurRadius="14" ShadowDepth="2" Opacity="0.35" Color="Black"/></Border.Effect>
          <StackPanel Orientation="Horizontal">
            <Ellipse x:Name="BubbleDot" Width="8" Height="8" Margin="0,0,8,0" VerticalAlignment="Center" Fill="#FF3B82F6"/>
            <TextBlock x:Name="BubbleText" Foreground="#FFF4F4F5" FontSize="12.5" TextWrapping="Wrap" MaxWidth="200" VerticalAlignment="Center"/>
          </StackPanel>
        </Border>
        <Path x:Name="BubbleTail" Data="M0,0 L7,7 L14,0" Fill="#FF18181B" Stroke="#FF3F3F46" StrokeThickness="1"
              HorizontalAlignment="Left" Margin="20,-1,0,0"/>
      </StackPanel>
      <Border x:Name="Toast" VerticalAlignment="Bottom" HorizontalAlignment="Left" Margin="10,0,0,0" MaxWidth="250" CornerRadius="14"
              Background="#FF18181B" BorderBrush="#FF2E2E33" BorderThickness="1" Padding="10,8,14,8" Visibility="Collapsed">
        <StackPanel Orientation="Horizontal">
          <Border Width="24" Height="24" CornerRadius="12" Background="#FF22C55E" Margin="0,0,9,0" VerticalAlignment="Center">
            <TextBlock x:Name="ToastIcon" FontFamily="Segoe Fluent Icons, Segoe MDL2 Assets" Foreground="White" FontSize="11"
                       HorizontalAlignment="Center" VerticalAlignment="Center"/>
          </Border>
          <StackPanel>
            <TextBlock x:Name="ToastTitle" Text="Task completed!" Foreground="#FFF4F4F5" FontWeight="SemiBold" FontSize="12.5"/>
            <TextBlock x:Name="ToastText" Foreground="#FFA1A1AA" FontSize="11.5" TextWrapping="Wrap" MaxWidth="190"/>
          </StackPanel>
        </StackPanel>
      </Border>
      <Grid x:Name="Bot" Width="300" Height="276" VerticalAlignment="Bottom" HorizontalAlignment="Left"
            Cursor="Hand" Background="Transparent" RenderTransformOrigin="0.38,1">
        <Grid.LayoutTransform><ScaleTransform x:Name="BotSize"/></Grid.LayoutTransform>
        <Grid.RenderTransform><TransformGroup><ScaleTransform x:Name="Squish"/><ScaleTransform x:Name="Rest"/><TranslateTransform x:Name="Hop"/></TransformGroup></Grid.RenderTransform>
        <Ellipse x:Name="Shadow" Width="150" Height="20" HorizontalAlignment="Left" VerticalAlignment="Bottom" Margin="42,0,0,28"
                 RenderTransformOrigin="0.5,0.5" IsHitTestVisible="False">
          <Ellipse.Fill>
            <RadialGradientBrush>
              <GradientStop Color="#AA3B82F6" Offset="0"/>
              <GradientStop Color="#333B82F6" Offset="0.55"/>
              <GradientStop Color="#003B82F6" Offset="1"/>
            </RadialGradientBrush>
          </Ellipse.Fill>
          <Ellipse.RenderTransform><ScaleTransform x:Name="ShadowScale"/></Ellipse.RenderTransform>
        </Ellipse>
        <Grid x:Name="Avatar" Width="300" Height="255" VerticalAlignment="Top" RenderTransformOrigin="0.38,0.68">
          <Grid.RenderTransform>
            <TransformGroup><ScaleTransform x:Name="Appear"/><RotateTransform x:Name="Peek"/><RotateTransform x:Name="Sway"/><TranslateTransform x:Name="Float"/></TransformGroup>
          </Grid.RenderTransform>
          <Image x:Name="Body" Stretch="Uniform" RenderOptions.BitmapScalingMode="HighQuality"/>
          <Image x:Name="PonyOld" Stretch="Uniform" RenderOptions.BitmapScalingMode="HighQuality"/>
          <!-- The pony turns and pulses about where it leaves the body (150, 136 on the 363 x 308 layers). -->
          <Image x:Name="Glow" Stretch="Uniform" Opacity="0" RenderOptions.BitmapScalingMode="HighQuality" RenderTransformOrigin="0.413,0.442"/>
          <Image x:Name="Pony" Stretch="Uniform" RenderOptions.BitmapScalingMode="HighQuality" RenderTransformOrigin="0.413,0.442">
            <Image.RenderTransform><TransformGroup><ScaleTransform x:Name="PonyScale"/><RotateTransform x:Name="PonyPose"/><RotateTransform x:Name="PonyTurn"/></TransformGroup></Image.RenderTransform>
          </Image>
          <!-- The eyes, drawn live on the layers' 363 x 308 grid (centres 121 / 163, 210) so they morph,
               blink and glide; GazeT moves both. -->
          <Viewbox Stretch="Uniform" IsHitTestVisible="False">
            <Canvas x:Name="Face" Width="363" Height="308">
              <Canvas>
                <Canvas.RenderTransform><TranslateTransform x:Name="GazeT"/></Canvas.RenderTransform>
                <Grid Canvas.Left="101" Canvas.Top="170" Width="40" Height="80">
                  <Rectangle x:Name="EyeL" Width="18" Height="42" RadiusX="9" RadiusY="9" Fill="#FFFAFAFC" HorizontalAlignment="Center" VerticalAlignment="Center" RenderTransformOrigin="0.5,0.5">
                    <Rectangle.RenderTransform><TransformGroup><ScaleTransform x:Name="EyeLS"/><TranslateTransform x:Name="EyeLT"/></TransformGroup></Rectangle.RenderTransform>
                  </Rectangle>
                  <Path x:Name="HappyL" Data="M 11,45 Q 20,29 29,45" Stroke="#FFFAFAFC" StrokeThickness="5" StrokeStartLineCap="Round" StrokeEndLineCap="Round" Opacity="0"/>
                </Grid>
                <Grid Canvas.Left="143" Canvas.Top="170" Width="40" Height="80">
                  <Rectangle x:Name="EyeR" Width="18" Height="42" RadiusX="9" RadiusY="9" Fill="#FFFAFAFC" HorizontalAlignment="Center" VerticalAlignment="Center" RenderTransformOrigin="0.5,0.5">
                    <Rectangle.RenderTransform><TransformGroup><ScaleTransform x:Name="EyeRS"/><TranslateTransform x:Name="EyeRT"/></TransformGroup></Rectangle.RenderTransform>
                  </Rectangle>
                  <Path x:Name="HappyR" Data="M 11,45 Q 20,29 29,45" Stroke="#FFFAFAFC" StrokeThickness="5" StrokeStartLineCap="Round" StrokeEndLineCap="Round" Opacity="0"/>
                </Grid>
              </Canvas>
            </Canvas>
          </Viewbox>
          <Image x:Name="Fx" Stretch="Uniform" RenderOptions.BitmapScalingMode="HighQuality"/>
        </Grid>
        <Border x:Name="Badge" HorizontalAlignment="Left" VerticalAlignment="Top" Margin="194,92,0,0" MinWidth="34" Height="34" CornerRadius="17"
                Background="#FFF59E0B" BorderBrush="White" BorderThickness="2" Visibility="Collapsed" Padding="5,0">
          <TextBlock x:Name="BadgeText" Foreground="White" FontWeight="Bold" FontSize="17" HorizontalAlignment="Center" VerticalAlignment="Center"/>
        </Border>
      </Grid>
    </Grid>
  </Grid>
</Window>
"@
$win = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $xaml))
$el = @{}
foreach ($n in "Panel","CloseBtn","PauseBtn","Pills","ActBtn","Hint","Input","Chips","Scroll","Feed","Bubble","BubbleText","Toast","ToastIcon","ToastText",
               "StatusDot","StatusText","CtrlBtn","FolderBtn","Bot","Squish","Hop","Shadow","ShadowScale","Avatar","Appear","Sway","Float","Body","PonyOld","Pony","PonyScale","PonyPose","PonyTurn","Rest","Peek","Glow","Fx","Face","GazeT","EyeL","EyeR","EyeLS","EyeRS","EyeLT","EyeRT","HappyL","HappyR","Badge","BadgeText","VoiceBtn","HeadFace","Stage","BotSize","BubbleDot","BubbleTail","NameText") { $el[$n] = $win.FindName($n) }
function Brush($hex) { New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString($hex)) }
function Anim($from, $to, $ms, $reverse, $forever) {
  $a = New-Object System.Windows.Media.Animation.DoubleAnimation($from, $to, [TimeSpan]::FromMilliseconds($ms))
  $a.AutoReverse = $reverse
  if ($forever) { $a.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever }
  $a
}

# ------------------------------------------------------------------ place: anchored by its bottom-right corner
$wa = [System.Windows.SystemParameters]::WorkArea
$script:anchor = @{ right = $wa.Right - 16; bottom = $wa.Bottom - 4 }
$script:muted = $false; $script:voiceName = "cc_bright"   # a voice.py preset or Kokoro voice, or a "Microsoft ..." Windows voice
$script:voiceChosen = $false   # true once you pick a voice in the menu
$script:bodyChosen = $false; $script:peekChosen = $false   # the same for the colour and auto-hide: until then the config says
$script:ccName = "cc"
$script:size = 0.65   # cc's scale; the bubble and chat keep their size
$script:bodyVariant = "charcoal"   # the board's colour variations; the pony keeps the state colours
$script:peekAfter = 3                # minutes without you before cc hides on the screen's side; 0 = never
try {
  $sc = Get-Content (Join-Path $Root "studio.config.json") -Raw -ErrorAction Stop | ConvertFrom-Json
  if ($sc.assistant.voice) { $script:voiceName = $sc.assistant.voice }
  if ($sc.assistant.color) { $script:bodyVariant = $sc.assistant.color }
  if ($sc.assistant.name) { $script:ccName = $sc.assistant.name }
  if ($null -ne $sc.assistant.autoHideMinutes) { $script:peekAfter = [int]$sc.assistant.autoHideMinutes }
} catch {}
if (Test-Path $PosFile) {
  try { $p = Get-Content $PosFile -Raw | ConvertFrom-Json
        if ($p.right -gt $wa.Left + 120 -and $p.right -le $wa.Right + 1 -and $p.bottom -gt $wa.Top + 150 -and $p.bottom -le $wa.Bottom + 1) {
          $script:anchor = @{ right = [double]$p.right; bottom = [double]$p.bottom } }
        if ($null -ne $p.muted) { $script:muted = [bool]$p.muted }
        if ($p.voice -and $p.voiceChosen) { $script:voiceName = $p.voice; $script:voiceChosen = $true }
        if ($p.size -ge 0.4 -and $p.size -le 1) { $script:size = [double]$p.size }
        if ($p.body -and $p.bodyChosen) { $script:bodyVariant = $p.body; $script:bodyChosen = $true }
        if ($null -ne $p.peek -and $p.peekChosen) { $script:peekAfter = [int]$p.peek; $script:peekChosen = $true } } catch {}
}
$el.NameText.Text = $script:ccName; $win.Title = $script:ccName
function Save-Settings {
  @{ right = $script:anchor.right; bottom = $script:anchor.bottom; muted = $script:muted; voice = $script:voiceName; voiceChosen = $script:voiceChosen; size = $script:size; body = $script:bodyVariant; bodyChosen = $script:bodyChosen; peek = $script:peekAfter; peekChosen = $script:peekChosen } | ConvertTo-Json | Set-Content $PosFile
}
# The avatar is drawn at 300 x 276; in those units the body is centred at x 117 and the pony's
# tip, at its highest, is 262 above the bottom. cc is centred in the stage and the bubble sits on its halo.
function Set-Size($s) {
  $script:size = $s
  $el.BotSize.ScaleX = $s; $el.BotSize.ScaleY = $s
  $el.Stage.Width = [Math]::Max(260, 300 * $s); $el.Stage.Height = 262 * $s + 84
  $left = [Math]::Max(0, [Math]::Min($el.Stage.Width - 300 * $s, $el.Stage.Width / 2 - 117 * $s))
  $el.Bot.Margin = "$left,0,0,0"
  $script:haloX = $left + 117 * $s
  $el.Bubble.Margin = "0,0,0,$(262 * $s + 2)"; Place-Bubbles
}
function Place-Bubbles {   # centre the bubble and toast over the halo, inside the stage; the tail points at it
  foreach ($b in $el.Bubble, $el.Toast) {
    $x = [Math]::Max(2, [Math]::Min($el.Stage.Width - $b.ActualWidth - 2, $script:haloX - $b.ActualWidth / 2))
    $b.Margin = "$x,0,0,$($el.Bubble.Margin.Bottom + $(if ($b -eq $el.Toast) { 7 } else { 0 }))"
  }
  $el.BubbleTail.Margin = "$([Math]::Max(10, $script:haloX - $el.Bubble.Margin.Left - 7)),-1,0,0"
}
$el.Bubble.Add_SizeChanged({ Place-Bubbles }); $el.Toast.Add_SizeChanged({ Place-Bubbles })
Set-Size $script:size

# ------------------------------------------------------------------ voice
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
# The Windows voice speaks when the offline voice can't: the chosen one, else a male stand-in
# for cc's male voices and Zira for the others.
function Set-Fallback {
  $n = $(if ($script:voiceName -like "Microsoft*") { $script:voiceName } elseif ($script:voiceName -match '^(cc_|am_|bm_)') { "Microsoft David Desktop" } else { "Microsoft Zira Desktop" })
  try { $synth.SelectVoice($n) } catch {}
}
Set-Fallback
$synth.Rate = 1
$player = New-Object System.Windows.Media.MediaPlayer
$script:talking = $false; $script:speakSeq = 0; $script:voiceStarted = [datetime]::MinValue
$player.Add_MediaEnded({ $script:talking = $false })
$player.Add_MediaFailed({ $script:talking = $false })
function Start-Voice {
  # At most once a minute, so a broken voice setup can't respawn it in a loop.
  if (((Get-Date) - $script:voiceStarted).TotalSeconds -lt 60 -or -not (Test-Path $VoicePy)) { return }
  $script:voiceStarted = Get-Date
  Log "warn" "the voice server isn't answering; starting it (the Windows voice fills in meanwhile)"
  Start-Process $VoicePy "`"$VoiceScript`"" -WindowStyle Hidden
}
$months = (Get-Culture).DateTimeFormat.MonthNames
# Account names and the words the voice gets wrong, from the desk (the projects' profiles:
# an account's "name", a project's "pronounce" map); updated with every state poll.
$script:names = @{}; $script:pronounce = @{}
function Nice-Account($a) { if ($script:names[$a]) { $script:names[$a] } else { ($a -replace '-', ' ') } }
$dayNames = @{ Mon = "Monday"; Tue = "Tuesday"; Wed = "Wednesday"; Thu = "Thursday"; Fri = "Friday"; Sat = "Saturday"; Sun = "Sunday" }
$monNames = @{ Jan = "January"; Feb = "February"; Mar = "March"; Apr = "April"; Jun = "June"; Jul = "July"; Aug = "August"; Sep = "September"; Sept = "September"; Oct = "October"; Nov = "November"; Dec = "December" }
# Text as it should sound, checked by ear through Kokoro and Whisper (2026-10-04):
# "mybrand-tiktok-2026-10-06-001" -> "My Brand's October 6 post", "Wed, Oct 7" -> "Wednesday, October 7"
# (Kokoro said "wed ox"), 17:30 -> "5:30 PM", W41 -> "week 41", your "pronounce" words (a brand
# Kokoro mangles, spelled as it should sound); curly quotes are straightened (they were dropped: "Brand s"); parentheses, slashes,
# units and abbreviations are spelled out; markdown, bullets, links and emoji are dropped.
function Speakable($t) {
  $t = $t -replace '[\u2018\u2019]', "'" -replace '[\u201C\u201D]', '"' -replace '\s*[\u2013\u2014]\s*', ', ' -replace '\u2026', '.'
  $t = [regex]::Replace($t, '\b([a-z0-9]+(?:-[a-z0-9]+)*?)-(\d{4})-(\d{2})-(\d{2})-\d{3}\b', { param($m)
    "{0}'s {1} {2} post" -f (Nice-Account $m.Groups[1].Value), $months[[int]$m.Groups[3].Value - 1], [int]$m.Groups[4].Value })
  foreach ($id in @($script:names.Keys | Sort-Object Length -Descending)) { $t = $t -replace ('\b' + [regex]::Escape($id) + '\b'), $script:names[$id] }
  $t = [regex]::Replace($t, '\b(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}))?\b', { param($m) ("{0} {1}" -f $months[[int]$m.Groups[2].Value - 1], [int]$m.Groups[3].Value) + $(if ($m.Groups[4].Success) { " at " + $m.Groups[4].Value } else { "" }) })
  $t = [regex]::Replace($t, '\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\.?(?=\s+\d)', { param($m) $monNames[$m.Groups[1].Value] })
  $t = [regex]::Replace($t, '\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\.?(?=,|\s+\d|\s+[A-Z][a-z])', { param($m) $dayNames[$m.Groups[1].Value] })
  $t = [regex]::Replace($t, '\b(?:\d{4}-)?W(\d{2})\b', { param($m) "week " + [int]$m.Groups[1].Value })
  $t = [regex]::Replace($t, '\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*[AaPp]\.?[Mm]\b)', { param($m)   # 24 h only; "12:14 PM" stays
    $h = [int]$m.Groups[1].Value; $mm = $m.Groups[2].Value
    $h12 = $(if ($h % 12 -eq 0) { 12 } else { $h % 12 }); "$h12$(if ($mm -ne '00') { ':' + $mm }) $(if ($h -lt 12) { 'AM' } else { 'PM' })" })
  $t = [regex]::Replace($t, '(\d)\s?(ms|s|min|h|MB)\b', { param($m)
    "$($m.Groups[1].Value) " + @{ ms = "milliseconds"; s = "seconds"; min = "minutes"; h = "hours"; MB = "megabytes" }[$m.Groups[2].Value] })
  $t = $t -replace 'https?://\S+', 'a link' -replace '\*\*|__|`|(?m)^#+\s*', '' -replace '(?m)^\s*([-*]|\d+[.)])\s+', '' -replace ':\s*\n', '. '
  $t = $t -replace '\be\.g\.', 'for example' -replace '\bi\.e\.', 'that is' -replace '\betc\.', 'and so on' -replace '\bvs\.?(?=\s)', 'versus'
  $t = $t -replace '\s*\(\s*', ', ' -replace '\s*\)', ',' -replace '(?<=[A-Za-z])/(?=[A-Za-z])', ' or ' -replace ' - ', ', ' -replace '#(?=\d)', 'number '
  $t = $t -replace '->', ' to ' -replace '&', ' and ' -replace '%', ' percent' -replace '_', ' '
  foreach ($w in @($script:pronounce.Keys)) { $t = $t -creplace ('\b' + [regex]::Escape($w) + '\b'), $script:pronounce[$w] }
  $t = $t -replace '[^\x20-\x7E\r\n]', ' ' -replace '\s*\n\s*', '. ' -replace '\s+([,.!?;])', '$1' -replace ',([,.!?;])', '$1' -replace '([.!?])\.+', '$1' -replace '\s{2,}', ' '
  if ($t.Length -gt 500) { $t = $t.Substring(0, 500) }
  $t.Trim(" ,")
}
# Lines are rendered by Kokoro as soon as they are queued (the server does them in order) and
# play back to back; a new answer or a stop clears the queue (gen) so nothing stale plays.
$script:vq = New-Object System.Collections.ArrayList
$script:vgen = 0
function Stop-Talking { $script:vgen++; $script:vq.Clear(); $synth.SpeakAsyncCancelAll(); $player.Stop(); $script:talking = $false }
function Queue-Speech($text) {
  if ($script:muted -or -not $text) { return }
  $line = Speakable $text
  if (-not $line) { return }
  if ($script:voiceName -like "Microsoft*") { [void]$synth.SpeakAsync($line); return }
  $item = @{ text = $line; path = $null; failed = $false; gen = $script:vgen }
  [void]$script:vq.Add($item)
  Request "$VoiceUrl/speak" @{ text = $line; voice = $script:voiceName } {
    param($r, $it)
    if ($r -and $r.path) { $it.env = @($r.env); $it.envMs = $(if ($r.ms) { [double]$r.ms } else { 25 }); $it.path = $r.path }
    else { $it.failed = $true; Start-Voice }   # voice server down: Zira, and restart it
  } $item
}
function Speak($text) { Stop-Talking; Queue-Speech $text }
function Play-Next {   # from the clock: the next queued line, once its audio exists
  if ($script:talking -or $synth.State -eq "Speaking" -or $script:vq.Count -eq 0) { return }
  $it = $script:vq[0]
  if ($it.gen -ne $script:vgen) { $script:vq.RemoveAt(0); return }
  if ($it.path) { $script:vq.RemoveAt(0); $script:env = $it.env; $script:envMs = $it.envMs; $player.Open([Uri]$it.path); $player.Play(); $script:talking = $true }
  elseif ($it.failed) { $script:vq.RemoveAt(0); [void]$synth.SpeakAsync($it.text) }
}
$ear = $null
try { $ear = New-Object CcEar } catch {}
# Opening the chat grows the window to the left and up, so cc itself never jumps.
$win.Add_SizeChanged({ if ($script:peeking -or $script:peekBusy) { return }; $win.Left = $script:anchor.right - $win.ActualWidth; $win.Top = $script:anchor.bottom - $win.ActualHeight })

# ------------------------------------------------------------------ desk requests, never blocking the UI
$client = New-Object System.Net.Http.HttpClient
$client.Timeout = [TimeSpan]::FromSeconds(150)
$pending = New-Object System.Collections.ArrayList
function Request($path, $body, $onDone, $ctx) {
  if ($null -ne $body) {
    $content = New-Object System.Net.Http.StringContent(($body | ConvertTo-Json -Compress), [Text.Encoding]::UTF8, "application/json")
    $task = $client.PostAsync($(if ($path -like "http*") { $path } else { "$Desk$path" }), $content)
  } else { $task = $client.GetAsync($(if ($path -like "http*") { $path } else { "$Desk$path" })) }
  [void]$pending.Add(@{ task = $task; done = $onDone; ctx = $ctx })
}
$pump = New-Object System.Windows.Threading.DispatcherTimer
$pump.Interval = [TimeSpan]::FromMilliseconds(150)
$pump.Add_Tick({
  foreach ($item in @($pending)) {
    if (-not $item.task.IsCompleted) { continue }
    $pending.Remove($item)
    $obj = $null
    try { $obj = $item.task.Result.Content.ReadAsStringAsync().Result | ConvertFrom-Json } catch {}
    if ($item.done) { & $item.done $obj $item.ctx }
  }
})

# ------------------------------------------------------------------ speech bubble (when the panel is closed)
$bubbleTimer = New-Object System.Windows.Threading.DispatcherTimer
$bubbleTimer.Interval = [TimeSpan]::FromSeconds(9)
$bubbleTimer.Add_Tick({ $el.Bubble.Visibility = "Collapsed"; $bubbleTimer.Stop() })
function Say($text, $speak) {
  if ($speak) { Speak $text }
  if ($el.Panel.Visibility -eq "Visible" -or $script:peeking -or $script:peekBusy) { return }
  $el.BubbleText.Text = $text
  $el.BubbleDot.Fill = Brush $dotColor[$(if ($script:accent) { $script:accent } else { "blue" })]
  # The dot breathes while cc is working, so the line needs no "..."
  $el.BubbleDot.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $(if ($script:mood -eq "busy") { Anim 1 0.25 700 $true $true } else { $null }))
  $el.Bubble.Visibility = "Visible"; $el.Toast.Visibility = "Collapsed"
  $bubbleTimer.Stop(); $bubbleTimer.Start()
}
$dotColor = @{ blue = "#FF2C7DFF"; orange = "#FFFF7A1A"; purple = "#FF9B3BFF"; red = "#FFFF3B30"; cyan = "#FF19D3F0"; green = "#FF2ED15A"; pink = "#FFFF5FA8"; yellow = "#FFFFC21A" }

# ------------------------------------------------------------------ the chat feed
function Scroll-End { $el.Scroll.ScrollToEnd() }
function Add-Msg($text, $me) {
  $tb = New-Object System.Windows.Controls.TextBlock
  $tb.Text = $text; $tb.TextWrapping = "Wrap"; $tb.FontSize = 13.5; $tb.LineHeight = 20
  $tb.Foreground = $(if ($me) { Brush "#FFF4F4F5" } else { Brush "#FFE4E4E7" })
  $b = New-Object System.Windows.Controls.Border
  $b.Child = $tb
  if ($me) { $b.Padding = "13,8"; $b.Margin = "60,4,0,12"; $b.CornerRadius = "18,18,4,18"; $b.Background = Brush "#FF27272A"; $b.HorizontalAlignment = "Right" }
  else { $b.Padding = "2,0,8,0"; $b.Margin = "0,0,0,14"; $b.HorizontalAlignment = "Left" }
  [void]$el.Feed.Children.Add($b); Scroll-End
  $tb
}
function New-Btn($text, $primary) {
  $btn = New-Object System.Windows.Controls.Button
  $btn.Content = $text
  if ($primary) { $btn.Background = Brush "#FFF4F4F5"; $btn.Foreground = Brush "#FF18181B"; $btn.BorderBrush = Brush "#FFF4F4F5"; $btn.FontWeight = "SemiBold" }
  $btn
}
function Act($body, $card) {
  if ($card) { foreach ($c in $card.Tag.buttons) { $c.IsEnabled = $false } }
  Request "/api/widget/act" $body { param($r)
    $msg = $(if ($r) { @($r.message, $r.error) | Where-Object { $_ } | Select-Object -First 1 } else { "I couldn't reach the desk just now. Try again in a moment." })
    Add-Msg $msg $false | Out-Null; Speak $msg; Refresh } $null
}

# A suggested action from the assistant: a button, run only on a tap.
function Add-Suggestion($a) {
  $row = New-Object System.Windows.Controls.WrapPanel
  $row.Margin = "0,0,0,8"
  $label = "Do it: $($a.action)"; if ($a.key) { $label += " $($a.key)" }; if ($a.feedback) { $label += " - `"$($a.feedback)`"" }
  $yes = New-Btn $label $true; $no = New-Btn "No" $false
  $yes.Tag = @{ action = $a; row = $row }; $no.Tag = $row
  $yes.Add_Click({ $t = $this.Tag; $el.Feed.Children.Remove($t.row)
    $body = @{ action = $t.action.action }; foreach ($k in "key","cut","feedback") { if ($t.action.$k) { $body[$k] = $t.action.$k } }
    Act $body $null })
  $no.Add_Click({ $el.Feed.Children.Remove($this.Tag) })
  [void]$row.Children.Add($yes); [void]$row.Children.Add($no)
  [void]$el.Feed.Children.Add($row); Scroll-End
}

# Controls: grouped buttons, each sending the chat command it is named after. Account rows
# come from the live state (pause or resume each, make its next video).
function New-Card {   # a card in the feed; returns the stack to fill
  $card = New-Object System.Windows.Controls.Border
  $card.Background = Brush "#FF1F1F23"; $card.BorderBrush = Brush "#FF3F3F46"; $card.BorderThickness = "1"
  $card.CornerRadius = "14"; $card.Padding = "12,10,8,6"; $card.Margin = "0,0,0,14"
  $stack = New-Object System.Windows.Controls.StackPanel; $card.Child = $stack
  [void]$el.Feed.Children.Add($card)
  $stack
}
function Add-Group($stack, $title, $items) {
  $h = New-Object System.Windows.Controls.TextBlock
  $h.Text = $title; $h.FontSize = 11; $h.FontWeight = "SemiBold"; $h.Foreground = Brush "#FF71717A"; $h.Margin = "2,2,0,6"
  [void]$stack.Children.Add($h)
  $row = New-Object System.Windows.Controls.WrapPanel; $row.Margin = "0,0,0,4"
  foreach ($it in $items) {
    $b = New-Btn $it[0] $false; $b.FontSize = 12; $b.Padding = "10,4"; $b.Tag = $it[1]
    $b.Add_Click({ Send-Chat $this.Tag }); [void]$row.Children.Add($b)
  }
  [void]$stack.Children.Add($row)
}
# Quick access: every folder the desk knows (its FOLDERS list), one tap each.
function Add-Folders {
  $f = @($script:state.folders | Where-Object { $_ })
  if (-not $f.Count) { Add-Msg "I can't get the folder list from the desk right now." $false | Out-Null; return }
  $stack = New-Card
  Add-Group $stack "FOLDERS" @($f | ForEach-Object { , @($_.label, "open $($_.label.ToLower())") })
  Scroll-End
}
function Add-Controls {
  $s = $script:state
  $stack = New-Card
  Add-Group $stack "ASK" @(@("Status", "status"), @("What's next", "what's next"), @("This week", "this week"), @("Problems", "errors"))
  $make = @(, @("Make next video", "next"))
  $acc = @($s.accounts | Where-Object { $_ })
  foreach ($a in $acc) { if (-not $a.paused) { $make += , @("Next: $($a.name)", "next $($a.name)") } }
  Add-Group $stack "MAKE A VIDEO" $make
  Add-Group $stack "PUBLISHING" @(@("Publish now", "publish now"), @("Check logins", "check logins"), @("Run a pulse", "pulse"), @("Restart Telegram bot", "restart bot"),
                       $(if ($s.paused) { , @("Resume everything", "resume") } else { , @("Pause everything", "pause") }))
  if ($acc.Count) { Add-Group $stack "ACCOUNTS" @($acc | ForEach-Object { if ($_.paused) { , @("Resume $($_.name)", "resume $($_.name)") } else { , @("Pause $($_.name)", "pause $($_.name)") } }) }
  Add-Group $stack "FOLDERS" @(@("Finals", "open finals"), @("Waiting video", "open waiting video"), @("Week plans", "open plans"), @("Calendar", "open calendar"),
                              @("Latest report", "open latest report"), @("All folders", "folders"))
  Add-Group $stack "CC" @($(if ($script:muted) { , @("Unmute", "unmute") } else { , @("Mute", "mute") }), @("Small", "size small"), @("Medium", "size medium"), @("Large", "size large"), @("Clear chat", "clear"))
  Scroll-End
}

# cc's own settings answer here, without the desk: mute, unmute, size, clear.
function Local-Command($w) {
  switch -regex ($w) {
    '^(mute|voice off|be quiet|stop talking)$' { Set-Muted $true; return "Muted. Say unmute to hear me again." }
    '^(unmute|voice on)$' { Set-Muted $false; return "I'm back." }
    '^size (small|medium|large|extra large)$' {
      Set-Size (@{ small = 0.5; medium = 0.65; large = 0.85; "extra large" = 1.0 }[$Matches[1]]); Save-Settings; Log "info" "size set to $($Matches[1])"
      return "Okay, $($Matches[1])." }
    '^(hide|go hide|peek|hide on the side)$' { Toggle-Panel; After 350 { Go-Peek }; return "See you. Click my pony to bring me back." }
    '^(clear|clear chat|clear the chat)$' {
      $el.Feed.Children.Clear(); $script:cards = @{}; $script:chipRow = $null; $script:history.Clear()
      try { Remove-Item $HistFile -ErrorAction Stop } catch {}
      return "Cleared. Ask me anything, or say help." }
  }
  $null
}

# The video waiting for review, playable, with Approve / Redo / Skip.
$script:cards = @{}
function Add-Card($v) {
  $id = "$($v.key):$($v.cut)"
  if ($script:cards.ContainsKey($id)) { return }
  $card = New-Object System.Windows.Controls.Border
  $card.Background = Brush "#FF27272A"; $card.BorderBrush = Brush "#FF3F3F46"; $card.BorderThickness = "1"
  $card.CornerRadius = "14"; $card.Padding = "10"; $card.Margin = "0,0,0,10"
  $stack = New-Object System.Windows.Controls.StackPanel
  $card.Child = $stack
  if ($v.has_video) {
    $media = New-Object System.Windows.Controls.MediaElement
    $media.LoadedBehavior = "Manual"; $media.UnloadedBehavior = "Stop"; $media.ScrubbingEnabled = $true
    $media.Height = 300; $media.Stretch = "Uniform"; $media.Cursor = "Hand"
    $media.Source = [Uri]("$Desk/video?key=$([Uri]::EscapeDataString($v.key))&cut=$($v.cut)")
    $media.Tag = @{ playing = $false }
    $media.Add_MediaOpened({ $this.Pause(); $this.Position = [TimeSpan]::FromMilliseconds(600) })
    $media.Add_MediaEnded({ $this.Stop(); $this.Tag.playing = $false })
    $media.Add_MouseLeftButtonUp({ if ($this.Tag.playing) { $this.Pause() } else { $this.Play() }; $this.Tag.playing = -not $this.Tag.playing })
    $media.Volume = 0.8
    $media.Add_Loaded({ $this.Play() })   # loads the first frame; MediaOpened pauses it
    $frame = New-Object System.Windows.Controls.Border
    $frame.Background = Brush "#FF000000"; $frame.CornerRadius = "10"; $frame.Child = $media; $frame.ClipToBounds = $true
    [void]$stack.Children.Add($frame)
    $hint = New-Object System.Windows.Controls.TextBlock
    $hint.Text = "Click the video to play or pause"; $hint.FontSize = 11; $hint.Foreground = Brush "#FFA1A1AA"; $hint.Margin = "0,4,0,0"
    [void]$stack.Children.Add($hint)
  }
  $meta = New-Object System.Windows.Controls.TextBlock
  $meta.Text = "{0} - {1} {2} - cut {3} - AI label {4}" -f $v.account, $v.day, $v.post_at, $v.cut, $(if ($v.is_aigc) { "ON" } else { "off" })
  $meta.FontSize = 11.5; $meta.Foreground = Brush "#FFA1A1AA"; $meta.Margin = "0,6,0,2"; $meta.TextWrapping = "Wrap"
  $hook = New-Object System.Windows.Controls.TextBlock
  $hook.Text = '"' + $v.hook + '"'; $hook.FontSize = 13.5; $hook.FontWeight = "SemiBold"; $hook.TextWrapping = "Wrap"; $hook.Margin = "0,0,0,8"; $hook.Foreground = Brush "#FFF4F4F5"
  [void]$stack.Children.Add($meta); [void]$stack.Children.Add($hook)
  $row = New-Object System.Windows.Controls.WrapPanel
  $approve = New-Btn "Approve" $true; $redo = New-Btn "Redo..." $false; $skip = New-Btn "Skip" $false
  $card.Tag = @{ v = $v; buttons = @($approve, $redo, $skip) }
  foreach ($b in $approve, $redo, $skip) { $b.Tag = $card; [void]$row.Children.Add($b) }
  $approve.Add_Click({ $v = $this.Tag.Tag.v; Act @{ action = "approve"; key = $v.key; cut = $v.cut } $this.Tag })
  $skip.Add_Click({ $v = $this.Tag.Tag.v; Act @{ action = "skip"; key = $v.key; cut = $v.cut } $this.Tag })
  $redo.Add_Click({
    # Inline: what should change, then send.
    $card = $this.Tag
    $box = New-Object System.Windows.Controls.TextBox
    $box.Margin = "0,4,0,6"; $box.Padding = "6,4"; $box.FontSize = 13; $box.TextWrapping = "Wrap"
    $send = New-Btn "Send redo" $true
    $send.Tag = @{ card = $card; box = $box }
    $send.Add_Click({ $t = $this.Tag; if (-not $t.box.Text.Trim()) { return }; $v = $t.card.Tag.v; $this.IsEnabled = $false
      Act @{ action = "redo"; key = $v.key; cut = $v.cut; feedback = $t.box.Text.Trim() } $t.card })
    $card.Child.Children.Add((New-Object System.Windows.Controls.TextBlock -Property @{ Text = "What should change?"; FontSize = 12; Margin = "0,4,0,0" }))
    [void]$card.Child.Children.Add($box); [void]$card.Child.Children.Add($send)
    $box.Focus() | Out-Null; Scroll-End
  })
  [void]$stack.Children.Add($row)
  [void]$el.Feed.Children.Add($card)
  $script:cards[$id] = $card
  Scroll-End
}

# Typing indicator: an empty reply bubble cycles its dots until the first words arrive.
$script:typing = New-Object System.Collections.ArrayList
function Start-Typing($tb) { $tb.Foreground = Brush "#FFA1A1AA"; [void]$script:typing.Add($tb) }
function Stop-Typing($tb) { if ($script:typing.Contains($tb)) { $script:typing.Remove($tb); $tb.Foreground = Brush "#FFE4E4E7" } }
$dot = [string][char]0x2022

# Quick replies under cc's answer; only the latest row stays.
$script:chipRow = $null
function Add-Chips($chips) {
  if ($script:chipRow) { $el.Feed.Children.Remove($script:chipRow) }
  $chips = @($chips | Where-Object { $_ })
  if (-not $chips.Count) { $script:chipRow = $null; return }
  $row = New-Object System.Windows.Controls.WrapPanel; $row.Margin = "0,0,0,8"
  foreach ($c in $chips) {
    $b = New-Btn $c $false; $b.FontSize = 12; $b.Padding = "11,4"; $b.Background = Brush "#00000000"; $b.Tag = $c
    $b.Add_Click({ Send-Chat $this.Tag }); [void]$row.Children.Add($b)
  }
  [void]$el.Feed.Children.Add($row); $script:chipRow = $row; Scroll-End
}

# History: the last 40 lines survive a restart (shown dimmed above the greeting).
$HistFile = Join-Path $env:APPDATA "cc-studio-cc-chat.json"
$script:history = New-Object System.Collections.ArrayList
if (Test-Path $HistFile) { try { foreach ($h in @(Get-Content $HistFile -Raw | ConvertFrom-Json)) { [void]$script:history.Add(@{ r = $h.r; t = $h.t }) } } catch {} }
function Save-Chat($role, $text) {
  [void]$script:history.Add(@{ r = $role; t = $text })
  while ($script:history.Count -gt 40) { $script:history.RemoveAt(0) }
  try { ConvertTo-Json -InputObject @($script:history | ForEach-Object { [pscustomobject]$_ }) -Depth 3 | Set-Content $HistFile -Encoding UTF8 } catch {}
}
function Show-History {
  if (-not $script:history.Count) { return }
  foreach ($h in $script:history) { $tb = Add-Msg $h.t ($h.r -eq "me"); $tb.Parent.Opacity = 0.55 }
  $sep = New-Object System.Windows.Controls.TextBlock
  $sep.Text = "earlier"; $sep.FontSize = 11; $sep.Foreground = Brush "#FF71717A"; $sep.HorizontalAlignment = "Center"; $sep.Margin = "0,2,0,10"
  [void]$el.Feed.Children.Add($sep)
}

# Speak the finished sentences of a streaming answer, keeping track of what was said.
$MaxSpoken = 4
function Speak-New($ctx, $text, $done) {
  $upto = $ctx.spoken
  if ($done) { $upto = $text.Length }
  else { foreach ($m in [regex]::Matches($text, '([.!?]["'')]?\s|\n)')) { if ($m.Index + $m.Length -gt $upto) { $upto = $m.Index + $m.Length } } }
  if ($upto -gt $ctx.spoken) {
    # One line per sentence: the first starts playing while the rest are still being rendered.
    foreach ($part in [regex]::Split($text.Substring($ctx.spoken, $upto - $ctx.spoken), '(?<=[.!?])\s+|
')) {
      if (-not $part.Trim()) { continue }
      $ctx.said = 1 + $ctx.said
      if ($ctx.said -le $MaxSpoken) { Queue-Speech $part }
      elseif ($ctx.said -eq $MaxSpoken + 1) { Queue-Speech "There's more in the chat." }
    }
    $ctx.spoken = $upto
  }
}
function Finish-Chat($ctx, $text, $r) {
  $script:chatPending = [Math]::Max(0, $script:chatPending - 1)
  $ms = [int]((Get-Date) - $ctx.t0).TotalMilliseconds
  if ($r) { Log "info" "chat answered in $ms ms" @{ chars = $text.Length } } else { Log "warn" "chat got no answer from the desk after $ms ms" }
  Stop-Typing $ctx.tb; $ctx.tb.Text = $text
  if ($r -and $r.speech) { Queue-Speech $r.speech } else { Speak-New $ctx $text $true }
  Save-Chat "cc" $text
  if ($r -and $r.suggest) { Add-Suggestion $r.suggest }
  if ($r -and $r.controls) { Add-Controls }
  if ($r -and $r.folders) { Add-Folders }
  if ($r -and $r.chips) { Add-Chips $r.chips }
  Scroll-End; Refresh
}
function Poll-Chat($ctx) {
  Request "/api/chat/poll?id=$($ctx.id)" $null {
    param($r, $ctx)
    if (-not $r) { Finish-Chat $ctx "The desk server didn't answer." $null; return }
    $text = [string]$r.text
    if ($text) { Stop-Typing $ctx.tb; $ctx.tb.Text = $text; Scroll-End }
    if ($r.done) { Finish-Chat $ctx $text $r }
    else { Speak-New $ctx $text $false; Poll-Chat $ctx }
  } $ctx
}
function Send-Chat($text) {
  if (-not $text.Trim()) { return }
  if ($script:chipRow) { $el.Feed.Children.Remove($script:chipRow); $script:chipRow = $null }
  Stop-Talking
  $local = Local-Command ($text.Trim().ToLower() -replace '[.!?]+$', '')
  if ($local) {
    if ($local -notlike "Cleared*") { Add-Msg $text $true | Out-Null }
    Add-Msg $local $false | Out-Null; Queue-Speech $local; Log "info" "local command: $text"; return
  }
  Add-Msg $text $true | Out-Null; Save-Chat "me" $text
  $tb = Add-Msg "" $false; Start-Typing $tb
  $script:chatPending++
  Log "info" "chat asked" @{ q = $(if ($text.Length -gt 200) { $text.Substring(0, 200) } else { $text }) }
  Request "/api/chat" @{ text = $text } {
    param($r, $c)
    $ctx = @{ tb = $c.tb; t0 = $c.t0; spoken = 0; id = $null }
    if ($r -and $r.id) { $ctx.id = $r.id; Poll-Chat $ctx; return }
    Finish-Chat $ctx $(if ($r -and $r.reply) { $r.reply } elseif ($r -and $r.error) { $r.error } else { "The desk server didn't answer." }) $r
  } @{ tb = $tb; t0 = Get-Date }
}

# ------------------------------------------------------------------ moods and status pills
$script:mood = ""; $script:lastText = ""; $script:lastReview = 0; $script:state = $null; $script:lastDone = $null; $script:lastUpcoming = @()
# ------------------------------------------------------------------ the avatar
$AvatarDir = Join-Path $Root "cc-avatar"   # npm run avatar
$img = @{}
foreach ($f in Get-ChildItem $AvatarDir -Filter *.png -ErrorAction SilentlyContinue) {
  $bmp = New-Object System.Windows.Media.Imaging.BitmapImage
  $bmp.BeginInit(); $bmp.CacheOption = "OnLoad"; $bmp.UriSource = [Uri]$f.FullName; $bmp.EndInit(); $bmp.Freeze()
  $img[$f.BaseName] = $bmp
}
# The board's state colours (the pony and the bubble's dot): blue idle, pink a video ready, orange
# making one, red a problem, cyan focus (waiting out a Claude limit); asleep keeps blue.
$accentFor = @{ ok = "blue"; wait = "pink"; busy = "orange"; bad = "red"; sleep = "blue"; focus = "cyan" }
$ponyHex = @{ blue = "#2C7DFF"; green = "#2ED15A"; yellow = "#FFC21A"; purple = "#9B3BFF"; red = "#FF3B30"; orange = "#FF7A1A"; pink = "#FF5FA8"; cyan = "#19D3F0" }
$script:accent = "blue"; $script:shownBody = ""; $script:shownEyes = ""; $script:shownFx = ""; $script:tick = 0
$script:shownPony = ""; $script:ponyColor = "blue"; $script:ponyMotion = ""; $script:resting = $false
$script:nextBlink = (Get-Date).AddSeconds(4); $script:shownPose = ""; $script:gazeX = 0; $script:gazeY = 0
$script:saccade = @(0, 0); $script:nextSaccade = Get-Date
$script:happyUntil = [datetime]::MinValue; $script:sparksUntil = [datetime]::MinValue
$script:glanceUntil = [datetime]::MinValue; $script:nextGlance = (Get-Date).AddSeconds(10); $script:glanceDir = "left"
$script:hoverSince = $null; $script:dragging = $false; $script:chatPending = 0; $script:micOn = $false; $script:glowing = $false

function Set-Layer($name, $key) {   # the body
  if ($key -ne $script:shownBody -and $img[$key]) { $el.Body.Source = $img[$key]; $script:shownBody = $key }
}
# Animate a property from wherever it is now to a value, eased (retargeting mid-way stays smooth).
function Morph($target, $prop, $to, $ms = 200) {
  $a = New-Object System.Windows.Media.Animation.DoubleAnimation([double]$to, [TimeSpan]::FromMilliseconds($ms))
  $a.EasingFunction = Ease "Cubic" "EaseOut"; $target.BeginAnimation($prop, $a)
}
# Effects fade in and out; the frames of one effect (waves0-2) just follow each other.
function Set-Fx($key) {
  if ($key -eq $script:shownFx) { return }
  $same = $key -and $script:shownFx -and (($key -replace '\d$', '') -eq ($script:shownFx -replace '\d$', ''))
  $script:shownFx = $key
  if ($same) { $el.Fx.Source = $img[$key]; return }
  if ($key) { $el.Fx.Source = $img[$key]; $el.Fx.BeginAnimation([System.Windows.UIElement]::OpacityProperty, (Anim 0 1 200 $false $false)) }
  else { Morph $el.Fx ([System.Windows.UIElement]::OpacityProperty) 0 220; After 230 { if (-not $script:shownFx) { $el.Fx.Source = $null } } }
}
# The eyes: shapes morph between expressions (w, h, y shift on the layer grid), happy arcs fade
# over the pills, blinks close and open, and the gaze glides toward its target.
$eyeShapes = @{ neutral = @(18, 42, 0); big = @(21, 50, 0); error = @(16, 32, 0); think = @(18, 38, -5); flat = @(20, 7, 0); sleepy = @(20, 6, 8) }
function Set-Eyes($kind) {
  if (-not $eyeShapes[$kind] -and $kind -ne "happy") { $kind = "neutral" }
  if ($kind -eq $script:shownEyes) { return }
  $script:shownEyes = $kind
  $happy = $kind -eq "happy"
  foreach ($x in $el.EyeL, $el.EyeR) { Morph $x ([System.Windows.UIElement]::OpacityProperty) $(if ($happy) { 0 } else { 1 }) 160 }
  foreach ($x in $el.HappyL, $el.HappyR) { Morph $x ([System.Windows.UIElement]::OpacityProperty) $(if ($happy) { 1 } else { 0 }) 160 }
  if ($happy) { return }
  $w, $h, $dy = $eyeShapes[$kind]
  foreach ($x in $el.EyeL, $el.EyeR) {
    $hh = $(if ($kind -eq "think" -and $x -eq $el.EyeL) { $h - 8 } else { $h })   # thinking: one eye squints
    $r = [Math]::Min($w, $hh) / 2
    Morph $x ([System.Windows.FrameworkElement]::WidthProperty) $w 220
    Morph $x ([System.Windows.FrameworkElement]::HeightProperty) $hh 220
    Morph $x ([System.Windows.Shapes.Rectangle]::RadiusXProperty) $r 220
    Morph $x ([System.Windows.Shapes.Rectangle]::RadiusYProperty) $r 220
  }
  Morph $el.EyeLT ([System.Windows.Media.TranslateTransform]::YProperty) $dy 220
  Morph $el.EyeRT ([System.Windows.Media.TranslateTransform]::YProperty) $(if ($kind -eq "think") { $dy - 3 } else { $dy }) 220
}
function Blink {   # only open eyes blink: close and open in 180 ms
  if ($script:shownEyes -notin "neutral", "big", "think", "error") { return }
  foreach ($x in $el.EyeLS, $el.EyeRS) { $x.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleYProperty, (Keys @(1, 0.08, 1) 180)) }
}
function Set-EyeColor {   # dark eyes on the snow body
  $b = Brush $(if ($script:bodyVariant -eq "snow") { "#FF28292E" } else { "#FFFAFAFC" })
  $el.EyeL.Fill = $b; $el.EyeR.Fill = $b; $el.HappyL.Stroke = $b; $el.HappyR.Stroke = $b
}
function Set-Gaze($x, $y) {   # retargeted every tick, so the eyes follow the cursor smoothly
  if ([Math]::Abs($x - $script:gazeX) + [Math]::Abs($y - $script:gazeY) -lt 0.5) { return }
  $script:gazeX = $x; $script:gazeY = $y
  Morph $el.GazeT ([System.Windows.Media.TranslateTransform]::XProperty) $x 280
  Morph $el.GazeT ([System.Windows.Media.TranslateTransform]::YProperty) $y 280
}
# The pony: its colour and pose say the state. Poses are turns of the one pony about its base,
# so it swings from pose to pose with a little overshoot; a new colour fades in over the old,
# and the glow under cc follows it.
$poseAngle = @{ neutral = 0; up = -17; forward = 32; left = -42; right = 16; low = 63; fold = -109 }
function Set-Pony($color, $pose) {
  if ($pose -ne $script:shownPose) {
    $script:shownPose = $pose
    $a = New-Object System.Windows.Media.Animation.DoubleAnimation([double]$poseAngle[$pose], [TimeSpan]::FromMilliseconds(520))
    $a.EasingFunction = Ease "Back" "EaseOut" 0.45
    $el.PonyPose.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, $a)
  }
  if ($color -eq $script:shownPony) { return }
  $old = $el.Pony.Source
  $el.Pony.Source = $img["pony_${color}_neutral"]; $el.Glow.Source = $img["glow_${color}_neutral"]; $script:shownPony = $color
  if ($old) {
    $el.PonyOld.Source = $old
    $el.PonyOld.BeginAnimation([System.Windows.UIElement]::OpacityProperty, (Keys @(1, 1, 0) 420))
    $el.Pony.BeginAnimation([System.Windows.UIElement]::OpacityProperty, (Anim 0 1 380 $false $false))
  }
  $script:ponyColor = $color
  $c = [System.Windows.Media.ColorConverter]::ConvertFromString($ponyHex[$color]); $alpha = 0xAA, 0x33, 0
  for ($i = 0; $i -lt 3; $i++) {
    $ca = New-Object System.Windows.Media.Animation.ColorAnimation([System.Windows.Media.Color]::FromArgb($alpha[$i], $c.R, $c.G, $c.B), [TimeSpan]::FromMilliseconds(450))
    $el.Shadow.Fill.GradientStops[$i].BeginAnimation([System.Windows.Media.GradientStop]::ColorProperty, $ca)
  }
}
# How the pony moves: bob (idle, a slow few degrees), wag (happy, talking), pulse (working), none.
# A change first settles the pony from wherever it is, then starts the new loop from rest, so
# nothing jumps.
function Set-PonyMotion($m) {
  if ($m -eq $script:ponyMotion) { return }
  $script:ponyMotion = $m
  Morph $el.PonyTurn ([System.Windows.Media.RotateTransform]::AngleProperty) 0 180
  foreach ($p in [System.Windows.Media.ScaleTransform]::ScaleXProperty, [System.Windows.Media.ScaleTransform]::ScaleYProperty) { Morph $el.PonyScale $p 1 180 }
  After 190 {
    $loop = switch ($script:ponyMotion) { "bob" { Keys @(0, 3, 0, -3, 0) 2800 } "wag" { Keys @(0, 9, 0, -9, 0) 560 } default { $null } }
    if ($loop) { $loop.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever; $el.PonyTurn.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, $loop) }
    if ($script:ponyMotion -eq "pulse") {
      foreach ($p in [System.Windows.Media.ScaleTransform]::ScaleXProperty, [System.Windows.Media.ScaleTransform]::ScaleYProperty) {
        $k = Keys @(1, 1.1, 1) 1300; $k.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever; $el.PonyScale.BeginAnimation($p, $k) } }
  }
}
# Asleep, cc settles flatter, as on the board.
function Set-Rest($on) {
  if ($on -eq $script:resting) { return }
  $script:resting = $on
  $el.Rest.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleYProperty, (Anim $el.Rest.ScaleY $(if ($on) { 0.84 } else { 1 }) 600 $false $false))
  $el.Rest.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleXProperty, (Anim $el.Rest.ScaleX $(if ($on) { 1.06 } else { 1 }) 600 $false $false))
}
# ------------------------------------------------------------------ sound
# While cc speaks or listens, three small sound marks beside its head (as on the board's
# "Speaking" and "Listening") follow the real loudness:
# cc's own voice from the envelope the voice server sends with each line (synced to playback),
# the Windows voice from a lively stand-in, your voice from the mic level. The inner ripple is
# now, the outer ones the level 80 and 160 ms ago, so the sound visibly travels outward; each
# grows a little with its level, and the pony's aura brightens with it. A 40 ms loop that runs
# only while there is sound.
$script:ripples = @(); $script:soundOn = $false; $script:lvl = 0.0; $script:lvlHist = New-Object 'double[]' 6
$soundBrush = Brush "#FFB98BFF"
foreach ($i in 0..2) {   # arcs about a point just off the body's upper right (layer grid)
  $r = 12 + 10 * $i; $a = 42 * [Math]::PI / 180; $cx = 234; $cy = 160
  $x = $cx + $r * [Math]::Cos($a); $y1 = $cy - $r * [Math]::Sin($a); $y2 = $cy + $r * [Math]::Sin($a)
  $pth = New-Object System.Windows.Shapes.Path
  $pth.Data = [System.Windows.Media.Geometry]::Parse(("M {0:0.0},{1:0.0} A {2},{2} 0 0 1 {0:0.0},{3:0.0}" -f $x, $y1, $r, $y2))
  $pth.Stroke = $soundBrush; $pth.StrokeThickness = 4.2 - 0.6 * $i; $pth.StrokeStartLineCap = "Round"; $pth.StrokeEndLineCap = "Round"; $pth.Opacity = 0
  $sc = New-Object System.Windows.Media.ScaleTransform; $sc.CenterX = $cx; $sc.CenterY = $cy; $pth.RenderTransform = $sc
  $halo = New-Object System.Windows.Media.Effects.DropShadowEffect; $halo.ShadowDepth = 0; $halo.BlurRadius = 5; $halo.Opacity = 0.45; $halo.Color = $soundBrush.Color; $pth.Effect = $halo
  [void]$el.Face.Children.Insert(0, $pth)
  $script:ripples += , @($pth, $sc, $i, $halo)
}
$soundTimer = New-Object System.Windows.Threading.DispatcherTimer
$soundTimer.Interval = [TimeSpan]::FromMilliseconds(40)
$soundTimer.Add_Tick({
  $speaking = $script:talking -or $synth.State -eq "Speaking"
  $listening = $script:micOn -and $ear -and $ear.Listening
  $target = 0.0
  if ($script:talking -and $script:env) {
    $i = [int]($player.Position.TotalMilliseconds / $script:envMs)
    if ($i -lt $script:env.Count) { $target = [double]$script:env[$i] }
  } elseif ($synth.State -eq "Speaking") { $target = 0.3 + 0.5 * [Math]::Abs([Math]::Sin((Get-Date).Ticks / 900000)) * (Get-Random -Minimum 6 -Maximum 11) / 10 }
  elseif ($listening) { $target = [Math]::Min(1.0, $ear.Level / 55.0) }
  $script:lvl += ($target - $script:lvl) * $(if ($target -gt $script:lvl) { 0.65 } else { 0.28 })   # quick attack, softer release
  for ($j = $script:lvlHist.Length - 1; $j -gt 0; $j--) { $script:lvlHist[$j] = $script:lvlHist[$j - 1] }
  $script:lvlHist[0] = $script:lvl
  foreach ($rp in $script:ripples) {
    $v = $script:lvlHist[2 * $rp[2]]
    $rp[0].Opacity = [Math]::Max(0, [Math]::Min(0.9, 0.2 + $v * 1.8 - $rp[2] * 0.25))   # a faint inner mark even between words
    $rp[1].ScaleX = 0.92 + 0.1 * $v; $rp[1].ScaleY = $rp[1].ScaleX
  }
  $el.Glow.Opacity = 0.15 + 0.85 * $script:lvl
  if (-not $speaking -and -not $listening -and $script:lvlHist[5] -lt 0.02) {
    foreach ($rp in $script:ripples) { $rp[0].Opacity = 0 }
    $soundTimer.Stop(); $script:soundOn = $false; $script:glowing = $null   # the clock takes the glow back
  }
})
function Start-Sound($color) {   # purple for cc's voice, green for yours, softened toward white
  $c = [System.Windows.Media.ColorConverter]::ConvertFromString($color)
  $c = [System.Windows.Media.Color]::FromRgb([byte](0.72 * $c.R + 71), [byte](0.72 * $c.G + 71), [byte](0.72 * $c.B + 71))
  $soundBrush.Color = $c; foreach ($rp in $script:ripples) { $rp[3].Color = $c }
  if ($script:soundOn) { return }
  $script:soundOn = $true
  $el.Glow.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $null)
  $soundTimer.Start()
}
function Set-Glow($on) {
  if ($on -eq $script:glowing) { return }
  $script:glowing = $on
  $el.Glow.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $(if ($on) { Anim 0.25 0.85 650 $true $true } else { Anim $el.Glow.Opacity 0 300 $false $false }))
}
function Shake {   # error: one small shake, then still
  $k = New-Object System.Windows.Media.Animation.DoubleAnimationUsingKeyFrames
  $k.Duration = [TimeSpan]::FromMilliseconds(480)
  $t = 0; foreach ($v in 0, -5, 5, -4, 3, -1, 0) { [void]$k.KeyFrames.Add((New-Object System.Windows.Media.Animation.LinearDoubleKeyFrame($v, [System.Windows.Media.Animation.KeyTime]::FromTimeSpan([TimeSpan]::FromMilliseconds($t))))); $t += 80 }
  $el.Hop.BeginAnimation([System.Windows.Media.TranslateTransform]::XProperty, $k)
}
function Show-Toast($text) {
  if ($script:peeking -or $script:peekBusy) { return }
  $el.ToastIcon.Text = [string][char]0xE73E; $el.ToastText.Text = $text
  $el.Bubble.Visibility = "Collapsed"; $el.Toast.Visibility = "Visible"
  $el.Toast.BeginAnimation([System.Windows.UIElement]::OpacityProperty, (Anim 0 1 250 $false $false))
  $script:toastTimer.Stop(); $script:toastTimer.Start()
}
$script:toastTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:toastTimer.Interval = [TimeSpan]::FromSeconds(4)
$script:toastTimer.Add_Tick({ $el.Toast.Visibility = "Collapsed"; $script:toastTimer.Stop() })
function Celebrate($what) {   # success: pink, happy eyes, a wagging pony, sparks, a hop, a toast
  if ($script:peeking) { Come-Out }
  Touch
  $script:happyUntil = (Get-Date).AddSeconds(3); $script:sparksUntil = (Get-Date).AddSeconds(1.6)
  Hop; Boing 1.14
  $el.ShadowScale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleXProperty, (Anim 1 1.35 260 $true $false))
  if ($what) { Show-Toast $what; Speak "Done. $what." }
}
# ------------------------------------------------------------------ animation kit
# Keyframes through the values, evenly spaced over ms, eased; the base of every bigger motion.
function Keys($vals, $ms) {
  $k = New-Object System.Windows.Media.Animation.DoubleAnimationUsingKeyFrames
  $step = $ms / ($vals.Count - 1); $i = 0
  foreach ($v in $vals) {
    $f = New-Object System.Windows.Media.Animation.EasingDoubleKeyFrame([double]$v, [System.Windows.Media.Animation.KeyTime]::FromTimeSpan([TimeSpan]::FromMilliseconds($step * $i)))
    $f.EasingFunction = New-Object System.Windows.Media.Animation.SineEase; [void]$k.KeyFrames.Add($f); $i++ }
  $k
}
function Ease($kind, $mode, $amount) {   # Back (overshoot), Elastic (spring), Cubic
  $e = New-Object "System.Windows.Media.Animation.${kind}Ease"; $e.EasingMode = $mode
  if ($kind -eq "Back") { $e.Amplitude = $amount } elseif ($kind -eq "Elastic") { $e.Oscillations = 2; $e.Springiness = $amount }
  $e
}
function After($ms, $do) {   # run a block later on the UI thread
  $t = New-Object System.Windows.Threading.DispatcherTimer; $t.Interval = [TimeSpan]::FromMilliseconds($ms); $t.Tag = $do
  $t.Add_Tick({ $this.Stop(); & $this.Tag }); $t.Start()
}
# Squash and stretch about the feet: tall, short, a little tall, settle (width does the opposite).
function Boing($y, $from = 1) {
  $el.Squish.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleYProperty, (Keys @($from, $y, (2 - $y), (1 + ($y - 1) / 3), 1) 650))
  $el.Squish.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleXProperty, (Keys @((2 - $from), (2 - $y), $y, (1 - ($y - 1) / 3), 1) 650))
}
# Short-lived overrides of what the clock would show: eyes, pose, motion, look.
$script:ov = @{}
function Set-Ov($what, $value, $ms) { $script:ov[$what] = @($value, (Get-Date).AddMilliseconds($ms)) }
function Ov($what) { $o = $script:ov[$what]; if ($o -and (Get-Date) -lt $o[1]) { $o[0] } else { $null } }
function Touch { $script:lastActive = Get-Date }   # you did something: no resting, no hiding
$script:lastActive = Get-Date; $script:nextFidget = (Get-Date).AddSeconds(15)

# Idle fidgets, one every 12 to 25 s while nothing is going on (the board's movement sequences).
function Fidget {
  switch (Get-Random -Maximum 9) {
    0 { Set-Ov "look" "left" 900; After 950 { Set-Ov "look" "right" 900 } }                        # look around
    1 { Set-Ov "motion" "wag" 1500; Set-Ov "pose" "up" 1500 }                                        # a happy wag
    2 { Boing 1.12; Set-Ov "eyes" "flat" 450; Set-Ov "pose" "up" 700 }                                # stretch, eyes shut
    3 { Hop; Boing 1.06 }                                                                            # hop
    4 { Blink; After 300 { Blink } }                                                                 # double blink
    5 { $el.Hop.BeginAnimation([System.Windows.Media.TranslateTransform]::XProperty, (Keys @(0, -2, 2, -2, 2, -1, 1, 0) 420)); Set-Ov "motion" "wag" 500 }   # shiver
    6 { Yawn }
    7 { $el.Appear.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleXProperty, (Keys @(1, 0, -1, -1, -1, 0, 1) 2400)) }   # turn around, look back
    8 { Hop; After 360 { Hop; Boing 1.08 } }                                                         # bounce, bounce
  }
}
function Yawn {
  Set-Ov "eyes" "flat" 1500; Set-Ov "pose" "low" 700; After 700 { Set-Ov "pose" "up" 700 }
  $el.Squish.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleYProperty, (Keys @(1, 1.1, 1.1, 0.95, 1) 1500))
  $el.Squish.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleXProperty, (Keys @(1, 0.94, 0.94, 1.04, 1) 1500))
}

# ------------------------------------------------------------------ hide on the side
# After a while without you, cc slides to the nearer side of its screen and turns so only the
# pony pokes out (it keeps its state colour). Now and then it peeks out with its eyes; hover makes
# it peek; a click on the pony, a video for you or a problem brings it back with a spring.
# Geometry in avatar units (300 x 255): it turns about the body centre (114, 173); the body's top
# edge is y 112, the eyes y 190.
$script:peeking = $false; $script:peekBusy = $false; $script:peekSide = "right"
function Screen-Area {   # the work area of cc's monitor, in WPF units
  $src = [System.Windows.PresentationSource]::FromVisual($win)
  $k = $(if ($src) { $src.CompositionTarget.TransformToDevice.M11 } else { 1 })
  $c = New-Object System.Drawing.Point ([int](($win.Left + $win.ActualWidth / 2) * $k)), ([int](($win.Top + $win.ActualHeight / 2) * $k))
  $b = [System.Windows.Forms.Screen]::FromPoint($c).WorkingArea
  @{ left = $b.Left / $k; right = $b.Right / $k }
}
function Peek-Left($upto) {   # the window's Left that puts the screen edge at avatar y = upto
  $L = $el.Bot.Margin.Left; $s = $script:size
  if ($script:peekSide -eq "right") { $script:peekArea.right - ($L + $s * (114 + ($upto - 173))) }
  else { $script:peekArea.left - ($L + $s * (114 - ($upto - 173))) }
}
function Move-Win($to, $ms, $ease, $then) {
  $from = $win.Left; $win.Left = $to   # the base value first, so nothing jumps when the animation ends
  $a = New-Object System.Windows.Media.Animation.DoubleAnimation($from, $to, [TimeSpan]::FromMilliseconds($ms))
  $a.EasingFunction = $ease; $a.FillBehavior = "Stop"
  if ($then) { $a.Add_Completed($then) }
  $win.BeginAnimation([System.Windows.Window]::LeftProperty, $a)
}
function Go-Peek {
  if ($script:peeking -or $script:peekBusy -or $el.Panel.Visibility -eq "Visible") { return }
  $area = Screen-Area; $mid = $win.Left + $win.ActualWidth / 2
  $script:peekSide = $(if ($mid - $area.left -lt $area.right - $mid) { "left" } else { "right" }); $script:peekArea = $area
  $script:peekBusy = $true
  Log "info" "hiding on the $($script:peekSide) side"
  $el.Bubble.Visibility = "Collapsed"; $el.Toast.Visibility = "Collapsed"
  Set-Ov "look" $script:peekSide 900; Set-Ov "motion" "wag" 1300; Hop
  After 420 {
    $script:inDone = {
      if (-not $script:peekBusy -or $script:peeking) { return }
      $script:peekBusy = $false; $script:peeking = $true; $script:nextPeekaboo = (Get-Date).AddSeconds((Get-Random -Minimum 20 -Maximum 40)) }
    Move-Win (Peek-Left 112) 750 (Ease "Back" "EaseIn" 0.35) { & $script:inDone }
    After 1150 { & $script:inDone }
    $r = Anim 0 $(if ($script:peekSide -eq "right") { -90 } else { 90 }) 750 $false $false; $r.EasingFunction = Ease "Cubic" "EaseInOut"
    $el.Peek.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, $r)
    foreach ($x in $el.Shadow, $el.Badge) { $x.BeginAnimation([System.Windows.UIElement]::OpacityProperty, (Anim 1 0 300 $false $false)) }
  }
}
function Peek-Out($more) {   # while hiding: lean out so the eyes show, or back to just the pony
  if (-not $script:peeking -or $script:peekBusy) { return }
  Move-Win (Peek-Left $(if ($more) { 200 } else { 112 })) 380 (Ease "Back" "EaseOut" 0.6) $null
}
function Come-Out {
  if (-not $script:peeking) { return }
  $script:peeking = $false; $script:peekBusy = $true; Touch
  Log "info" "coming back out"
  Set-Ov "eyes" "big" 700; Set-Ov "pose" "up" 1200
  $script:outDone = {
    if (-not $script:peekBusy) { return }
    $win.BeginAnimation([System.Windows.Window]::LeftProperty, $null)
    $win.Left = $script:anchor.right - $win.ActualWidth; $win.Top = $script:anchor.bottom - $win.ActualHeight
    $script:peekBusy = $false
    Boing 1.18; Hop
    $script:happyUntil = (Get-Date).AddSeconds(1.8); $script:sparksUntil = (Get-Date).AddSeconds(1.2)
    if ($script:lastText) { Say $script:lastText } }
  Move-Win ($script:anchor.right - $win.ActualWidth) 700 (Ease "Back" "EaseOut" 0.7) { & $script:outDone }
  After 1100 { & $script:outDone }
  $r = Anim $el.Peek.Angle 0 950 $false $false; $r.EasingFunction = Ease "Elastic" "EaseOut" 5
  $el.Peek.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, $r)
  foreach ($x in $el.Shadow, $el.Badge) { $x.BeginAnimation([System.Windows.UIElement]::OpacityProperty, (Anim 0 1 500 $false $false)) }
}

function Disappear($then) {   # the concept's exit: shrink to a point and fade
  foreach ($p in [System.Windows.Media.ScaleTransform]::ScaleXProperty, [System.Windows.Media.ScaleTransform]::ScaleYProperty) { $el.Appear.BeginAnimation($p, (Anim 1 0.15 420 $false $false)) }
  $a = Anim 1 0 420 $false $false
  $a.Add_Completed($then)
  $el.Avatar.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $a)
}
function Appear {
  foreach ($p in [System.Windows.Media.ScaleTransform]::ScaleXProperty, [System.Windows.Media.ScaleTransform]::ScaleYProperty) { $el.Appear.BeginAnimation($p, (Anim 0.4 1 380 $false $false)) }
  $el.Avatar.BeginAnimation([System.Windows.UIElement]::OpacityProperty, (Anim 0 1 380 $false $false))
}

function Set-Mood($mood, $text, $badge) {
  if ($badge) { $el.BadgeText.Text = "$badge"; $el.Badge.Visibility = "Visible" } else { $el.Badge.Visibility = "Collapsed" }
  if ($mood -ne $script:mood) {
    if ($mood -in "wait", "bad") { Touch; if ($script:peeking) { Come-Out } }
    Log "info" "mood $(if ($script:mood) { $script:mood } else { 'none' }) -> ${mood}: $text"   # the cause is logged where it happens
    if ($mood -eq "bad" -and $script:mood) { Shake }; $script:accent = $accentFor[$mood]; $script:mood = $mood }
  # Spoken only when it matters (a video waiting, a problem); the rest just shows in the bubble.
  if ($text -ne $script:lastText) { Say $text ($script:lastText -ne "" -and $mood -in "wait", "bad"); $script:lastText = $text }
  $el.Bot.ToolTip = $text
}
function Hop {
  $a = Anim 0 -9 220 $true $false
  $el.Hop.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $a)
}
# "mybrand-tiktok-2026-10-05-001" -> "My Brand's Oct 5 post"
function Short($key) {
  if ($key -notmatch '^(.+)-(\d{4})-(\d{2})-(\d{2})-\d{3}$') { return $key }
  "{0}'s {1} {2} post" -f (Nice-Account $Matches[1]), $months[[int]$Matches[3] - 1].Substring(0, 3), [int]$Matches[4]
}
function Add-Pill($text, $color) {
  $dot = New-Object System.Windows.Shapes.Ellipse
  $dot.Width = 7; $dot.Height = 7; $dot.Fill = Brush $color; $dot.Margin = "0,0,5,0"; $dot.VerticalAlignment = "Center"
  $tb = New-Object System.Windows.Controls.TextBlock
  $tb.Text = $text; $tb.FontSize = 11.5; $tb.Foreground = Brush "#FFD4D4D8"
  $sp = New-Object System.Windows.Controls.StackPanel; $sp.Orientation = "Horizontal"
  [void]$sp.Children.Add($dot); [void]$sp.Children.Add($tb)
  $b = New-Object System.Windows.Controls.Border
  $b.Child = $sp; $b.Padding = "8,2"; $b.Margin = "0,0,5,5"; $b.CornerRadius = "10"; $b.BorderBrush = Brush "#FF3F3F46"; $b.BorderThickness = "1"; $b.Background = Brush "#FF27272A"
  [void]$el.Pills.Children.Add($b)
}

function Apply-State($s) {
  $script:state = $s
  if ($s -and $s.names) { $n = @{}; foreach ($pr in $s.names.PSObject.Properties) { $n[$pr.Name] = [string]$pr.Value }; $script:names = $n }
  if ($s -and $s.pronounce) { $n = @{}; foreach ($pr in $s.pronounce.PSObject.Properties) { $n[$pr.Name] = [string]$pr.Value }; $script:pronounce = $n }
  if (-not $s) {
    # One missed poll is usually a desk restart; after three (30 s) say so and start it again.
    if (++$script:deskMisses -lt 3) { return }
    $el.Pills.Children.Clear()
    if (((Get-Date) - $script:deskKick).TotalMinutes -gt 2) {
      $script:deskKick = Get-Date
      Log "warn" "the desk server missed $($script:deskMisses) polls; starting the 'cc-studio desk' task"
      try { Start-ScheduledTask -TaskName "cc-studio desk" -ErrorAction Stop } catch { Log "error" "couldn't start the desk task: $($_.Exception.Message)" }
    }
    Set-Mood "bad" "I lost my connection, so I'm restarting it. Give me a minute." "!"
    Add-Pill "reconnecting" "#FFEF4444"; $el.StatusText.Text = "Reconnecting"; $el.StatusDot.Fill = Brush "#FFEF4444"; return
  }
  if ($script:deskMisses -ge 3) { Log "info" "the desk server is answering again" }
  $script:deskMisses = 0
  $el.Pills.Children.Clear()
  $c = $s.counts
  $botOk = ($null -ne $s.bot_heartbeat_s) -and ($s.bot_heartbeat_s -lt 300)
  $issues = @($s.attention).Count
  $stuck = $c.blocked + $issues
  if ($s.paused) { Set-Mood "sleep" "I'm paused. Click me and tap Resume when you're ready." $null }
  elseif (-not $botOk) { Set-Mood "bad" "The Telegram bot stopped. Right-click me and pick Restart Telegram bot." "!" }
  elseif ($c.rendered -gt 0) {
    $v = @($s.review)[0]
    Set-Mood "wait" $(if ($c.rendered -eq 1) { "$(Short $v.key) is ready. Click me to watch it." }
                      else { "$($c.rendered) videos are ready, starting with $(Short $v.key). Click me." }) $c.rendered
    if ($c.rendered -gt $script:lastReview) { Hop }
  }
  elseif ($stuck -gt 0) {
    Set-Mood "bad" $(if ($stuck -eq 1) { "One post is stuck. Click me and I'll explain." } else { "$stuck posts are stuck. Click me and I'll explain." }) "!"
  }
  elseif ($s.creator) { Set-Mood "busy" "Making $(Short $s.creator)" $null }
  elseif ($s.quota_pause) { Set-Mood "focus" "Taking a short break until the Claude limit resets." $null }
  else { Set-Mood "ok" ("All good. {0} queued, {1} posted, {2} planned." -f ($c.approved + $c.queued), $c.posted, $c.planned) $null }
  $script:lastReview = $c.rendered
  $upcoming = @($s.upcoming | ForEach-Object { $_.key })
  if ($null -ne $script:lastDone -and ($c.posted + $c.queued) -gt $script:lastDone) {
    $new = @($upcoming | Where-Object { $_ -notin $script:lastUpcoming })[0]
    Celebrate $(if ($new) { "Queued $(Short $new) for TikTok" } else { "A video moved to TikTok" })
  }
  $script:lastDone = $c.posted + $c.queued; $script:lastUpcoming = $upcoming

  Add-Pill $(if ($s.paused) { "paused" } else { "running" }) $(if ($s.paused) { "#FFF59E0B" } else { "#FF22C55E" })
  Add-Pill $(if ($botOk) { "Telegram bot" } else { "bot down" }) $(if ($botOk) { "#FF22C55E" } else { "#FFEF4444" })
  if ($s.creator) { Add-Pill ("making " + (Short $s.creator)) "#FFA78BFA" } else { Add-Pill $(if ($s.quota_pause) { "Claude limit" } else { "creator idle" }) "#FF71717A" }
  Add-Pill "$($c.rendered) to review" $(if ($c.rendered) { "#FFF59E0B" } else { "#FF71717A" })
  if ($c.blocked) { Add-Pill "$($c.blocked) blocked" "#FFEF4444" }
  if ($issues) { Add-Pill "$issues upload issue$(if ($issues -gt 1) {'s'})" "#FFEF4444" }
  $retry = @($s.retrying).Count
  if ($retry) { Add-Pill "$retry upload$(if ($retry -gt 1) {'s'}) retrying" "#FFF59E0B" }
  Add-Pill ("{0} queued - {1} posted" -f ($c.approved + $c.queued), $c.posted) "#FF71717A"
  $el.PauseBtn.Content = [string][char]$(if ($s.paused) { 0xE768 } else { 0xE769 }); $el.PauseBtn.ToolTip = $(if ($s.paused) { "Resume the pipeline" } else { "Pause the pipeline" })
  $el.StatusText.Text = $(if ($s.paused) { "Paused" } elseif ($s.creator) { "Making a video" } else { "Online" })
  $el.StatusDot.Fill = Brush $(if ($s.paused) { "#FFF59E0B" } elseif ($s.creator) { "#FFA78BFA" } else { "#FF22C55E" })
  if ($el.Panel.Visibility -eq "Visible") { foreach ($v in @($s.review)) { if ($v) { Add-Card $v } } }
}
$script:deskMisses = 0; $script:deskKick = [datetime]::MinValue
function Refresh { Request "/api/widget" $null { param($s) Apply-State $s } $null }

# ------------------------------------------------------------------ open / close the chat
$script:greeted = $false
function Toggle-Panel {
  Touch
  if ($el.Panel.Visibility -eq "Visible") { $el.Panel.Visibility = "Collapsed"; return }
  $el.Bubble.Visibility = "Collapsed"
  $el.Panel.Visibility = "Visible"
  $win.Activate() | Out-Null; $el.Input.Focus() | Out-Null
  if (-not $script:greeted) { $script:greeted = $true; Show-History; Add-Msg "Hi, I'm cc. Ask me anything about your posts, or tap a suggestion below." $false | Out-Null; Send-Chat "status" }
  Refresh
}
$el.CloseBtn.Content = [string][char]0xE711
$el.CtrlBtn.Content = [string][char]0xE71D
$el.CtrlBtn.Add_Click({ Add-Controls })
$el.FolderBtn.Content = [string][char]0xE8B7
$el.FolderBtn.Add_Click({ Add-Folders })
$el.CloseBtn.Add_Click({ Toggle-Panel })
function Set-Muted($m) {
  $script:muted = $m; if ($m) { Stop-Talking }
  $el.VoiceBtn.Content = [string][char]$(if ($m) { 0xE74F } else { 0xE767 }); $el.VoiceBtn.ToolTip = $(if ($m) { "Voice is off" } else { "Voice is on" }); Save-Settings
}
$el.VoiceBtn.Add_Click({ Set-Muted (-not $script:muted) })
function Update-ActBtn {
  $has = [bool]$el.Input.Text
  $el.Hint.Visibility = $(if ($has) { "Collapsed" } else { "Visible" })
  $el.ActBtn.Content = [string][char]$(if ($has) { 0xE724 } elseif ($script:micOn) { 0xE720 } else { 0xE720 })
  $el.ActBtn.ToolTip = $(if ($has) { "Send" } else { "Talk to cc" })
}
$el.Input.Add_TextChanged({ Update-ActBtn })
$el.ActBtn.Add_Click({
  if ($el.Input.Text) { $t = $el.Input.Text; $el.Input.Text = ""; Send-Chat $t; return }
  if (-not $ear -or $ear.Listening) { return }
  Stop-Talking
  $script:micOn = $true; $el.ActBtn.IsEnabled = $false; $el.Hint.Text = "Listening..."
  try { $ear.Listen() } catch { $script:micOn = $false; $el.ActBtn.IsEnabled = $true; $el.Hint.Text = "Ask cc anything"; Add-Msg "I can't hear: $($_.Exception.Message)" $false | Out-Null; Log "warn" "mic failed to start: $($_.Exception.Message)" }
})
$el.PauseBtn.Add_Click({ Act @{ action = $(if ($script:state.paused) { "resume" } else { "pause" }) } $null })
$el.Input.Add_KeyDown({
  if ($_.Key -eq "Return") { $t = $el.Input.Text; $el.Input.Text = ""; Send-Chat $t }
  elseif ($_.Key -eq "Escape") { Toggle-Panel }
})
foreach ($chip in @(@("Status","status"), @("What's next?","what's next"), @("Any issues?","anything broken?"), @("Controls","help"))) {
  $b = New-Btn $chip[0] $false; $b.FontSize = 12; $b.Padding = "11,4"; $b.Background = Brush "#00000000"; $b.Tag = $chip[1]
  $b.Add_Click({ Send-Chat $this.Tag })
  [void]$el.Chips.Children.Add($b)
}

# ------------------------------------------------------------------ right-click controls
$menu = New-Object System.Windows.Controls.ContextMenu
function Add-Item($header, $action) {
  $i = New-Object System.Windows.Controls.MenuItem; $i.Header = $header; $i.Add_Click($action); [void]$menu.Items.Add($i); $i }
$miChat    = Add-Item "Open chat" { if ($el.Panel.Visibility -ne "Visible") { Toggle-Panel } }
$miApprove = Add-Item "Approve waiting video" {
  $v = @($script:state.review)[0]
  if ($v) { Request "/api/widget/act" @{ action = "approve"; key = $v.key; cut = $v.cut } { param($r) Say $(if ($r) { @($r.message, $r.error) | Where-Object { $_ } | Select-Object -First 1 } else { "I couldn't reach the desk just now. Try again in a moment." }); Refresh } $null } }
$miPause   = Add-Item "Pause" { Request "/api/widget/act" @{ action = $(if ($script:state.paused) { "resume" } else { "pause" }) } { Refresh } $null }
$miNext    = Add-Item "Make next video" { Request "/api/widget/act" @{ action = "next" } { Refresh } $null; Say "On it. I'll start the next video unless one is already in progress or waiting for you." }
$miTick    = Add-Item "Publish queued videos now" { Request "/api/widget/act" @{ action = "tick" } { Refresh } $null; Say "Uploading the queued videos to TikTok now." }
$miBot     = Add-Item "Restart Telegram bot" { Request "/api/widget/act" @{ action = "bot" } { Refresh } $null; Say "Restarting the Telegram bot. It'll be back in a few seconds." }
[void]$menu.Items.Add((New-Object System.Windows.Controls.Separator))
$miFolders = Add-Item "Open folder" {}
$menu.Add_Opened({
  $miFolders.Items.Clear()
  foreach ($f in @($script:state.folders | Where-Object { $_ })) {
    $fi = New-Object System.Windows.Controls.MenuItem; $fi.Header = $f.label; $fi.Tag = $f.key
    $fi.Add_Click({ Request "/api/widget/act" @{ action = "open"; key = $this.Tag } { param($r) if ($r -and $r.error) { Say $r.error } } $null })
    [void]$miFolders.Items.Add($fi)
  }
  $miFolders.IsEnabled = $miFolders.Items.Count -gt 0
})
$miErrors  = Add-Item "Show recent problems" { if ($el.Panel.Visibility -ne "Visible") { Toggle-Panel }; Send-Chat "errors" }
$miSide    = Add-Item "Hide on the side" { if ($el.Panel.Visibility -eq "Visible") { Toggle-Panel }; After 250 { Go-Peek } }
$miAuto    = Add-Item "Auto-hide" {}
foreach ($m in @(@("Off", 0), @("After 1 minute", 1), @("After 3 minutes", 3), @("After 10 minutes", 10))) {
  $ai = New-Object System.Windows.Controls.MenuItem; $ai.Header = $m[0]; $ai.Tag = $m[1]; $ai.IsCheckable = $true
  $ai.Add_Click({ $script:peekAfter = [int]$this.Tag; $script:peekChosen = $true; Save-Settings; Log "info" "auto-hide set to $($this.Tag) min" })
  [void]$miAuto.Items.Add($ai)
}
$menu.Add_Opened({ foreach ($ai in $miAuto.Items) { $ai.IsChecked = ([int]$ai.Tag -eq $script:peekAfter) } })
$miHide    = Add-Item "Hide for an hour" {
  Disappear { $win.Hide() }
  $script:hideTimer = New-Object System.Windows.Threading.DispatcherTimer
  $script:hideTimer.Interval = [TimeSpan]::FromHours(1)
  $script:hideTimer.Add_Tick({ $win.Show(); Appear; $script:hideTimer.Stop() }); $script:hideTimer.Start() }
$miMute    = Add-Item "Mute voice" { Set-Muted (-not $script:muted) }
$miVoice = New-Object System.Windows.Controls.MenuItem; $miVoice.Header = "Voice"
foreach ($v in @(@("cc: cute and chill", "cc_chill"), @("cc: cute and bright", "cc_bright"), @("cc: mellow", "cc_mellow"),
                 @("Heart (warm)", "af_heart"), @("Bella (bright)", "af_bella"), @("Nicole (soft)", "af_nicole"), @("Michael (calm, male)", "am_michael"),
                 @("Fenrir (deep, male)", "am_fenrir"), @("Emma (British)", "bf_emma"), @("Windows Zira (instant, robotic)", "Microsoft Zira Desktop"))) {
  $vi = New-Object System.Windows.Controls.MenuItem; $vi.Header = $v[0]; $vi.Tag = $v[1]; $vi.IsCheckable = $true
  $vi.Add_Click({ $script:voiceName = $this.Tag; $script:voiceChosen = $true; Set-Fallback; Save-Settings; Log "info" "voice set to $($this.Tag)"; Speak "Hey, it's cc. This is how I sound now." })
  [void]$miVoice.Items.Add($vi)
}
[void]$menu.Items.Insert($menu.Items.IndexOf($miMute) + 1, $miVoice)
$miBody = New-Object System.Windows.Controls.MenuItem; $miBody.Header = "Colour"
foreach ($b in "Charcoal", "Snow", "Sky", "Mint", "Lavender", "Pink", "Peach", "Yellow") {
  $bi = New-Object System.Windows.Controls.MenuItem; $bi.Header = $b; $bi.Tag = $b.ToLower(); $bi.IsCheckable = $true
  $bi.Add_Click({ $script:bodyVariant = $this.Tag; $script:bodyChosen = $true; Set-Layer "Body" "body_$($this.Tag)"; Set-EyeColor; Save-Settings; Log "info" "colour set to $($this.Tag)" })
  [void]$miBody.Items.Add($bi)
}
[void]$menu.Items.Insert($menu.Items.IndexOf($miVoice) + 1, $miBody)
$miSize = New-Object System.Windows.Controls.MenuItem; $miSize.Header = "Size"
foreach ($z in @(@("Small", 0.5), @("Medium", 0.65), @("Large", 0.85), @("Extra large", 1.0))) {
  $zi = New-Object System.Windows.Controls.MenuItem; $zi.Header = $z[0]; $zi.Tag = $z[1]; $zi.IsCheckable = $true
  $zi.Add_Click({ Set-Size $this.Tag; Save-Settings; Log "info" "size set to $($this.Tag)" })
  [void]$miSize.Items.Add($zi)
}
[void]$menu.Items.Insert($menu.Items.IndexOf($miVoice) + 1, $miSize)
$miQuit    = Add-Item "Quit cc" { Disappear { $win.Close() } }
$menu.Add_Opened({
  $v = @($script:state.review)[0]
  $miApprove.IsEnabled = [bool]$v
  $miApprove.Header = $(if ($v) { "Approve $(Short $v.key) (unwatched)" } else { "Approve waiting video" })
  $miPause.Header = $(if ($script:state.paused) { "Resume" } else { "Pause" })
  $miMute.Header = $(if ($script:muted) { "Unmute voice" } else { "Mute voice" })
  foreach ($vi in $miVoice.Items) { $vi.IsChecked = ($vi.Tag -eq $script:voiceName) }
  foreach ($zi in $miSize.Items) { $zi.IsChecked = ($zi.Tag -eq $script:size) }
  foreach ($bi in $miBody.Items) { $bi.IsChecked = ($bi.Tag -eq $script:bodyVariant) }
})
$el.Bot.ContextMenu = $menu

# Left button on cc: a press squishes it, a drag moves it (surprised), a click opens the chat.
# A click on the hiding pony brings cc out; otherwise a press squashes it (held while you hold),
# a drag moves it, and letting go springs it back up before the chat opens.
$el.Bot.Add_MouseLeftButtonDown({
  if ($script:peekBusy) { return }
  if ($script:peeking) { Come-Out; return }
  Touch
  $el.Squish.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleYProperty, (Anim 1 0.84 110 $false $false))
  $el.Squish.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleXProperty, (Anim 1 1.12 110 $false $false))
  $x = $win.Left; $y = $win.Top
  $script:dragging = $true; Set-Eyes "big"
  try { $win.DragMove() } catch {}
  $script:dragging = $false
  if ([Math]::Abs($win.Left - $x) -lt 3 -and [Math]::Abs($win.Top - $y) -lt 3) { Boing 1.16 0.84; Hop; Set-Ov "eyes" "happy" 700; Toggle-Panel }
  else {
    Boing 1.1 0.84; Set-Ov "eyes" "happy" 600
    $script:anchor = @{ right = $win.Left + $win.ActualWidth; bottom = $win.Top + $win.ActualHeight }
    Save-Settings
  }
})
# Hover: cc perks up (a boing, wide eyes, the pony up and wagging) and glows; a drowsy cc wakes
# with a start. The hiding pony leans out so its eyes show.
$el.Bot.Add_MouseEnter({
  $script:hoverSince = Get-Date
  if ($script:peekBusy) { return }
  if ($script:peeking) { Peek-Out $true; Set-Ov "eyes" "happy" 4000; Set-Ov "motion" "wag" 4000; return }
  $drowsy = ((Get-Date) - $script:lastActive).TotalSeconds -gt 90
  Touch
  Set-Ov "eyes" "big" $(if ($drowsy) { 600 } else { 280 }); Set-Ov "pose" "up" 900; Set-Ov "motion" "wag" 800
  Boing $(if ($drowsy) { 1.14 } else { 1.08 })
  if ($el.Panel.Visibility -ne "Visible") { Say $(if ($script:mood -eq "ok") { "Need a hand?" } else { $script:lastText }) }
})
$el.Bot.Add_MouseLeave({
  $script:hoverSince = $null
  if ($script:peekBusy) { return }
  if ($script:peeking) { Peek-Out $false; return }
  Touch; Boing 1.04
})

# ------------------------------------------------------------------ life
$clock = New-Object System.Windows.Threading.DispatcherTimer
$clock.Interval = [TimeSpan]::FromMilliseconds(110)
$clock.Add_Tick({
  $now = Get-Date; $script:tick++
  $happy = $now -lt $script:happyUntil
  $speaking = $script:talking -or $synth.State -eq "Speaking"
  $listening = $script:micOn -and $ear -and $ear.Listening
  # Where to look, as a gaze offset on the layer grid: toward the open chat, else at the cursor
  # in any direction (stronger the farther it is), else an occasional glance; plus small flicks.
  $gx = 0; $gy = 0
  if ($el.Panel.Visibility -eq "Visible") { $gx = -9; $gy = 2 }
  else {
    try {
      $c = [CcCursor]::Get(); $mid = $el.Bot.PointToScreen((New-Object System.Windows.Point(117, 171)))
      $dx = $c[0] - $mid.X; $dy = $c[1] - $mid.Y; $dist = [Math]::Sqrt($dx * $dx + $dy * $dy)
      if ($dist -lt 900) { $k = [Math]::Min(1, $dist / 260) / [Math]::Max($dist, 1); $gx = 10 * $dx * $k; $gy = 7 * $dy * $k }
      elseif ($now -lt $script:glanceUntil) { $gx = $(if ($script:glanceDir -eq "left") { -10 } else { 10 }) }
      elseif ($now -gt $script:nextGlance) {
        $script:glanceDir = @("left", "right")[(Get-Random -Maximum 2)]; $script:glanceUntil = $now.AddSeconds(1.4)
        $script:nextGlance = $now.AddSeconds((Get-Random -Minimum 9 -Maximum 18))
      }
    } catch {}
  }
  if ($now -gt $script:nextSaccade) {
    $script:saccade = @(((Get-Random -Minimum -20 -Maximum 21) / 10), ((Get-Random -Minimum -12 -Maximum 13) / 10))
    $script:nextSaccade = $now.AddMilliseconds((Get-Random -Minimum 900 -Maximum 2600))
  }
  if ($now -gt $script:nextBlink) { Blink; $script:nextBlink = $now.AddSeconds((Get-Random -Minimum 3 -Maximum 8)) }
  $petted = $script:hoverSince -and ($now - $script:hoverSince).TotalSeconds -gt 1.2
  # The board's states. Priority: drag > listening > speaking > thinking > success > error >
  # asleep > focus > making > a video ready > petted > idle (looking about, blinking).
  $eyes = "neutral"; $fx = $null; $color = $accentFor[$(if ($script:mood) { $script:mood } else { "ok" })]; $pose = "neutral"; $motion = "bob"
  if ($script:dragging) { $eyes = "big"; $pose = "up"; $color = $script:ponyColor; $fx = "fx_marks_$($script:ponyColor)"; $motion = "none" }
  elseif ($listening) { $color = "green"; $pose = "left"; $motion = "none"; Start-Sound "#FF2ED15A" }
  elseif ($speaking) { $color = "purple"; $motion = "wag"; Start-Sound "#FF9B3BFF" }
  elseif ($script:chatPending -gt 0) { $color = "yellow"; $pose = "right"; $eyes = "think"; $fx = "fx_q"; $motion = "none" }
  elseif ($happy) { $color = "pink"; $pose = "up"; $eyes = "happy"; $motion = "wag"; if ($now -lt $script:sparksUntil) { $fx = "fx_sparks" } }
  elseif ($script:mood -eq "bad") { $pose = "low"; $eyes = "error"; $fx = "fx_marks_red"; $motion = "none" }
  elseif ($script:mood -eq "sleep") { $pose = "fold"; $eyes = "sleepy"; $fx = "fx_zz"; $motion = "none" }
  elseif ($script:mood -eq "focus") { $pose = "up"; $eyes = "flat"; $fx = "fx_ring"; $motion = "none" }
  elseif ($script:mood -eq "busy") { $pose = "forward"; $eyes = "flat"; $motion = "pulse" }
  elseif ($script:mood -eq "wait") { $pose = "up" }
  elseif ($petted) { $eyes = "happy"; $motion = "wag" }
  # You're here (talking, listening, chat open): no resting, no hiding.
  if ($speaking -or $listening -or $script:chatPending -gt 0 -or $el.Panel.Visibility -eq "Visible" -or $script:hoverSince) { Touch }
  $idleFor = ($now - $script:lastActive).TotalSeconds
  $calm = $motion -eq "bob" -and -not $script:dragging -and -not $happy
  if ($calm -and $el.Panel.Visibility -eq "Visible") { $pose = "left" }                 # toward the chat
  elseif ($calm -and $script:mood -eq "ok" -and $idleFor -gt 90) {                        # resting: drowsy
    $eyes = "sleepy"; $pose = "low"; $motion = "none"
  }
  if ($calm) {   # the overrides from hover, clicks and fidgets
    if (Ov "look") { $gx = $(if ((Ov "look") -eq "left") { -10 } else { 10 }); $gy = 0 }
    if (Ov "eyes") { $eyes = Ov "eyes" }
    if (Ov "pose") { $pose = Ov "pose" }
    if (Ov "motion") { $motion = Ov "motion" }
  }
  if ($script:peeking) { $pose = "up" }
  if ($eyes -eq "think") { $gx = 6; $gy = -6 } elseif ($eyes -in "flat", "sleepy", "happy") { $gx = $gx / 3; $gy = 0 } elseif ($eyes -eq "big") { $gy = -3 }
  if ($eyes -in "neutral", "big", "error") { $gx += $script:saccade[0]; $gy += $script:saccade[1] }
  Set-Pony $color $pose; Set-PonyMotion $motion; Set-Rest ($script:mood -eq "sleep" -and -not $script:dragging)
  Set-Eyes $eyes; Set-Gaze $gx $gy; Set-Fx $fx
  # Fidgets while nothing is going on; a drowsy cc only yawns or nods.
  if ($now -gt $script:nextFidget) {
    $script:nextFidget = $now.AddSeconds((Get-Random -Minimum 12 -Maximum 26))
    if ($calm -and -not $script:peeking -and -not $script:peekBusy -and -not $script:hoverSince -and $el.Panel.Visibility -ne "Visible") {
      if ($idleFor -gt 90 -and $script:mood -eq "ok") {
        if ((Get-Random -Maximum 2) -eq 0) { Yawn } else { $el.Hop.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, (Keys @(0, 4, 4, 0) 1100)) } }
      else { Fidget }
    }
  }
  # Hiding: after peekAfter minutes without you, unless something needs you.
  if ($script:peekAfter -gt 0 -and -not $script:peeking -and -not $script:peekBusy -and $idleFor -gt $script:peekAfter * 60 -and
      $script:mood -notin "wait", "bad" -and -not $script:dragging -and $el.Panel.Visibility -ne "Visible") { Go-Peek }
  # While hiding: a peek-a-boo now and then, eyes out for a moment.
  if ($script:peeking -and -not $script:hoverSince -and $now -gt $script:nextPeekaboo) {
    $script:nextPeekaboo = $now.AddSeconds((Get-Random -Minimum 25 -Maximum 50))
    Peek-Out $true; Set-Ov "eyes" "happy" 1800; After 1700 { if ($script:peeking -and -not $script:hoverSince) { Peek-Out $false } }
  }
  if (-not $script:soundOn) { Set-Glow ($script:hoverSince -and -not $script:peeking) }
  Play-Next
  if ($script:tick % 4 -eq 0) { $n = ([int]($script:tick / 4) % 3) + 1; foreach ($tb in $script:typing) { $tb.Text = (@($dot) * $n) -join " " } }

  if ($script:micOn -and $ear -and -not $ear.Listening) {
    $script:micOn = $false; $el.ActBtn.IsEnabled = $true; $el.Hint.Text = 'Ask cc anything'
    if ($ear.Heard) { Send-Chat $ear.Heard } elseif ($ear.Error) { Add-Msg "I couldn't hear that: $($ear.Error)" $false | Out-Null; Log "warn" "mic error: $($ear.Error)" } else { Add-Msg "I didn't catch that. Try again, a little closer to the mic." $false | Out-Null }
  }
})
$poll = New-Object System.Windows.Threading.DispatcherTimer
$poll.Interval = [TimeSpan]::FromSeconds(10)
$poll.Add_Tick({ Refresh })

$win.Add_Loaded({
  $win.Left = $script:anchor.right - $win.ActualWidth; $win.Top = $script:anchor.bottom - $win.ActualHeight
  Request "$VoiceUrl/health" $null { param($r) if (-not $r) { Start-Voice } } $null
  $icon = Join-Path $AvatarDir "icon_256.png"
  if (Test-Path $icon) { $el.HeadFace.Source = New-Object System.Windows.Media.Imaging.BitmapImage([Uri]$icon) }
  if (Test-Path (Join-Path $AvatarDir "cc.ico")) { $win.Icon = [System.Windows.Media.Imaging.BitmapFrame]::Create([Uri](Join-Path $AvatarDir "cc.ico")) }
  foreach ($x in $el.Glow, $el.PonyOld) { $x.RenderTransform = $el.Pony.RenderTransform; $x.RenderTransformOrigin = $el.Pony.RenderTransformOrigin }   # they move with the pony
  Set-Layer "Body" "body_$($script:bodyVariant)"; Set-Pony "blue" "neutral"; Set-EyeColor; Set-Eyes "neutral"; Update-ActBtn
  # Standing on its feet now: a slow 2 px breath with the glow underneath, and a slight sway.
  $ease = New-Object System.Windows.Media.Animation.SineEase
  $f = Anim 0 -2 2600 $true $true; $f.EasingFunction = $ease
  $el.Float.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $f)
  foreach ($p in [System.Windows.Media.ScaleTransform]::ScaleXProperty, [System.Windows.Media.ScaleTransform]::ScaleYProperty) {
    $sh = Anim 1 0.94 2600 $true $true; $sh.EasingFunction = $ease; $el.ShadowScale.BeginAnimation($p, $sh) }
  $sw = Anim -1 1 6500 $true $true; $sw.EasingFunction = $ease
  $el.Sway.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, $sw)
  Appear
  $pump.Start(); $clock.Start(); $poll.Start(); Refresh
  Set-Muted $script:muted
  Say "Hi, I'm cc. Click me to chat, right-click for controls." $true
})
$win.Add_Closed({ Log "info" "cc closed"; $player.Close(); $synth.Dispose(); $client.Dispose(); $mutex.ReleaseMutex() })
$win.Dispatcher.Add_UnhandledException({
  param($sender, $e)
  Log "error" "cc hit an error and carried on: $($e.Exception.Message)" @{ where = "$($e.Exception.StackTrace)".Trim() }
  $e.Handled = $true
})
Log "info" "cc started" @{ pid = $PID; size = $script:size; voice = $script:voiceName; muted = $script:muted }
[void]$win.ShowDialog()
