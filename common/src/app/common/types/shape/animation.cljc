;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL

(ns app.common.types.shape.animation
  "Looping and one-shot CSS animations attached to a shape. The shape
  keeps a preset name and timing parameters; the keyframes for every
  preset are fixed and shared by the renderer and the code generator."
  (:require
   [app.common.data :as d]
   [app.common.schema :as sm]
   [cuerdas.core :as str]))

(def presets
  "Preset name -> keyframe body. Transforms use percentages so they
  scale with the animated element."
  {:spin       "from { transform: rotate(0deg); } to { transform: rotate(360deg); }"
   :pulse      "0%, 100% { transform: scale(1); } 50% { transform: scale(1.08); }"
   :blink      "0%, 100% { opacity: 1; } 50% { opacity: 0.2; }"
   :bounce     "0%, 100% { transform: translateY(0); } 50% { transform: translateY(-15%); }"
   :shake      "0%, 100% { transform: translateX(0); } 25% { transform: translateX(-4%); } 75% { transform: translateX(4%); }"
   :fade-in    "from { opacity: 0; } to { opacity: 1; }"
   :fade-out   "from { opacity: 1; } to { opacity: 0; }"
   :scale-in   "from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); }"
   :slide-up   "from { opacity: 0; transform: translateY(20%); } to { opacity: 1; transform: translateY(0); }"
   :slide-down "from { opacity: 0; transform: translateY(-20%); } to { opacity: 1; transform: translateY(0); }"
   :slide-left "from { opacity: 0; transform: translateX(20%); } to { opacity: 1; transform: translateX(0); }"
   :slide-right "from { opacity: 0; transform: translateX(-20%); } to { opacity: 1; transform: translateX(0); }"})

(def preset-types
  [:spin :pulse :blink :bounce :shake :fade-in :fade-out :scale-in
   :slide-up :slide-down :slide-left :slide-right])

(def easing-types
  #{:linear :ease :ease-in :ease-out :ease-in-out})

(def direction-types
  #{:normal :reverse :alternate :alternate-reverse})

(def schema:animation
  [:map {:title "Animation"}
   [:type [::sm/one-of (set preset-types)]]
   [:duration ::sm/safe-number]
   [:delay {:optional true} ::sm/safe-number]
   [:easing {:optional true} [::sm/one-of easing-types]]
   [:direction {:optional true} [::sm/one-of direction-types]]
   [:iterations {:optional true} [:or [:= :infinite] ::sm/safe-int]]
   [:hidden {:optional true} :boolean]])

(def check-animation
  (sm/check-fn schema:animation))

(def valid-animation?
  (sm/validator schema:animation))

(def default-iterations
  "Looping presets repeat forever; entrance/exit presets play once."
  {:spin :infinite :pulse :infinite :blink :infinite :bounce :infinite
   :shake :infinite})

(defn create-animation
  ([] (create-animation :spin))
  ([type]
   {:type       type
    :duration   1000
    :delay      0
    :easing     (if (= type :spin) :linear :ease-in-out)
    :direction  :normal
    :iterations (get default-iterations type 1)
    :hidden     false}))

(defn keyframes-name
  [type]
  (str "penpot-" (d/name type)))

(defn keyframes-css
  "The @keyframes rule for a preset."
  [type]
  (when-let [body (get presets type)]
    (str "@keyframes " (keyframes-name type) " { " body " }")))

(defn active?
  [animation]
  (and (some? animation)
       (not (:hidden animation))
       (contains? presets (:type animation))))

(defn animation->css-value
  "The value of the CSS `animation` shorthand for an animation."
  [{:keys [type duration delay easing direction iterations] :as animation}]
  (when (active? animation)
    (str/join " "
              [(keyframes-name type)
               (str (or duration 1000) "ms")
               (d/name (or easing :ease))
               (str (or delay 0) "ms")
               (let [n (or iterations 1)]
                 (if (= n :infinite) "infinite" (str n)))
               (d/name (or direction :normal))
               "both"])))
