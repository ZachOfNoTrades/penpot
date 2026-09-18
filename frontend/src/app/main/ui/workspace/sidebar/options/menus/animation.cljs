;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL

(ns app.main.ui.workspace.sidebar.options.menus.animation
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data :as d]
   [app.common.types.shape.animation :as ctsa]
   [app.main.data.workspace.shapes :as dwsh]
   [app.main.store :as st]
   [app.main.ui.components.title-bar :refer [title-bar*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.controls.numeric-input :refer [numeric-input*]]
   [app.main.ui.ds.controls.select :refer [select*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.util.i18n :refer [tr]]
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

(def ^:private type-options
  (mapv (fn [type]
          {:id (d/name type)
           :label (str/capital (str/replace (d/name type) "-" " "))})
        ctsa/preset-types))

(def ^:private easing-options
  (mapv (fn [easing] {:id (d/name easing) :label (d/name easing)})
        [:linear :ease :ease-in :ease-out :ease-in-out]))

(def ^:private direction-options
  (mapv (fn [direction]
          {:id (d/name direction)
           :label (str/replace (d/name direction) "-" " ")})
        [:normal :reverse :alternate :alternate-reverse]))

(def ^:private iteration-options
  [{:id "infinite" :label "∞ loop"}
   {:id "1" :label "1×"}
   {:id "2" :label "2×"}
   {:id "3" :label "3×"}
   {:id "5" :label "5×"}])

(defn- iterations->id
  [iterations]
  (if (= iterations :infinite) "infinite" (str iterations)))

(defn- get-iteration-options
  "The repeat options, plus the current count when it is not one of them."
  [iterations]
  (let [id (iterations->id iterations)]
    (if (some #(= id (:id %)) iteration-options)
      iteration-options
      (conj iteration-options {:id id :label (str id "×")}))))

(defn- parse-iterations
  [value]
  (if (= value "infinite")
    :infinite
    (d/parse-integer value 1)))

(mf/defc animation-content*
  [{:keys [value change-fn]}]
  (let [is-hidden (get value :hidden false)

        update-attr
        (mf/use-fn
         (mf/deps change-fn)
         (fn [attr value]
           (change-fn #(assoc-in % [:animation attr] value))))

        handle-type-change
        (mf/use-fn
         (mf/deps change-fn)
         (fn [type]
           (let [type (keyword type)]
             (change-fn
              (fn [shape]
                (update shape :animation
                        (fn [animation]
                          (let [defaults (ctsa/create-animation type)]
                            (-> animation
                                (assoc :type type)
                                (assoc :easing (:easing defaults))
                                (assoc :iterations (:iterations defaults)))))))))))

        handle-duration  (mf/use-fn (mf/deps update-attr) #(update-attr :duration (max 1 (or % 1000))))
        handle-delay     (mf/use-fn (mf/deps update-attr) #(update-attr :delay (max 0 (or % 0))))
        handle-easing    (mf/use-fn (mf/deps update-attr) #(update-attr :easing (keyword %)))
        handle-direction (mf/use-fn (mf/deps update-attr) #(update-attr :direction (keyword %)))
        handle-repeat    (mf/use-fn (mf/deps update-attr) #(update-attr :iterations (parse-iterations %)))

        handle-toggle-visibility
        (mf/use-fn
         (mf/deps change-fn)
         (fn [] (change-fn #(update-in % [:animation :hidden] not))))

        handle-delete
        (mf/use-fn
         (mf/deps change-fn)
         (fn [] (change-fn #(dissoc % :animation))))]

    [:*
     [:div {:class (stl/css-case :first-row true :hidden is-hidden)}
      [:> select* {:class (stl/css :type-select)
                   :default-selected (d/name (:type value))
                   :aria-label (tr "workspace.options.animation-options.type")
                   :options type-options
                   :disabled is-hidden
                   :on-change handle-type-change}]
      [:div {:class (stl/css :actions)}
       [:> icon-button* {:variant "ghost"
                         :aria-label (tr "workspace.options.animation-options.toggle")
                         :on-click handle-toggle-visibility
                         :tooltip-placement "top-left"
                         :icon (if is-hidden i/hide i/shown)}]
       [:> icon-button* {:variant "ghost"
                         :aria-label (tr "workspace.options.animation-options.remove")
                         :on-click handle-delete
                         :tooltip-placement "top-left"
                         :icon i/remove}]]]

     [:div {:class (stl/css :grid-row)}
      [:> numeric-input* {:class (stl/css :numeric-input)
                          :placeholder "ms"
                          :min 1
                          :step 50
                          :text-icon "ms"
                          :aria-label (tr "workspace.options.animation-options.duration")
                          :title (tr "workspace.options.animation-options.duration")
                          :on-change handle-duration
                          :disabled is-hidden
                          :value (:duration value)}]
      [:> numeric-input* {:class (stl/css :numeric-input)
                          :placeholder "ms"
                          :min 0
                          :step 50
                          :text-icon "+"
                          :aria-label (tr "workspace.options.animation-options.delay")
                          :title (tr "workspace.options.animation-options.delay")
                          :on-change handle-delay
                          :disabled is-hidden
                          :value (or (:delay value) 0)}]]

     [:div {:class (stl/css :grid-row)}
      [:> select* {:class (stl/css :half-select)
                   :default-selected (d/name (or (:easing value) :ease))
                   :aria-label (tr "workspace.options.animation-options.easing")
                   :options easing-options
                   :disabled is-hidden
                   :on-change handle-easing}]
      [:> select* {:class (stl/css :half-select)
                   :default-selected (iterations->id (or (:iterations value) 1))
                   :aria-label (tr "workspace.options.animation-options.repeat")
                   :options (get-iteration-options (or (:iterations value) 1))
                   :disabled is-hidden
                   :on-change handle-repeat}]]

     [:div {:class (stl/css :grid-row)}
      [:> select* {:class (stl/css :half-select)
                   :default-selected (d/name (or (:direction value) :normal))
                   :aria-label (tr "workspace.options.animation-options.direction")
                   :options direction-options
                   :disabled is-hidden
                   :on-change handle-direction}]]]))

(mf/defc animation-menu*
  [{:keys [ids values]}]
  (let [animation (get values :animation)
        multiple? (= :multiple animation)

        state*    (mf/use-state true)
        open?     (deref state*)
        toggle    (mf/use-fn #(swap! state* not))

        change!
        (mf/use-fn
         (mf/deps ids)
         (fn [update-fn]
           (st/emit! (dwsh/update-shapes ids update-fn))))

        handle-add
        (mf/use-fn
         (mf/deps change!)
         (fn [] (change! #(assoc % :animation (ctsa/create-animation)))))

        handle-delete-all
        (mf/use-fn
         (mf/deps change!)
         (fn [] (change! #(dissoc % :animation))))]

    [:section {:class (stl/css :element-set)
               :aria-label (tr "workspace.options.animation-options.title")}
     [:div {:class (stl/css :element-title)}
      [:> title-bar* {:collapsable (some? animation)
                      :collapsed (not open?)
                      :on-collapsed toggle
                      :title (tr "workspace.options.animation-options.title")
                      :class (stl/css-case :title-spacing (nil? animation))}
       (when (nil? animation)
         [:> icon-button* {:variant "ghost"
                           :aria-label (tr "workspace.options.animation-options.add")
                           :on-click handle-add
                           :icon i/add
                           :tooltip-placement "top-left"
                           :data-testid "add-animation"}])]]

     (when (and open? (some? animation))
       [:div {:class (stl/css :element-set-content)}
        (if multiple?
          [:div {:class (stl/css :first-row)}
           [:span {:class (stl/css :mixed-label)} (tr "labels.mixed-values")]
           [:> icon-button* {:variant "ghost"
                             :aria-label (tr "workspace.options.animation-options.remove")
                             :on-click handle-delete-all
                             :icon i/remove}]]
          ;; Selects read their value on mount: key by selection and
          ;; preset so a new shape or preset defaults show up.
          [:> animation-content* {:key (str (str/join "," ids) ":" (d/name (:type animation)))
                                  :value animation
                                  :change-fn change!}])])]))
